import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DesktopEnterpriseGate, type EnterpriseLoginWindowLike } from '../src/enterprise-gate.ts'
import type { DesktopEnterpriseLoginResult, DesktopEnterpriseLoginWindowInput, DesktopEnterpriseLoginWindowOptions } from '../src/enterprise-login-window.ts'
import type { DesktopLanHttpsPrivateKeyProtector } from '../src/lan-https-certificate.ts'
import { EnterpriseOAuthError } from '../src/enterprise-oauth.ts'
import type { EnterpriseTokenSet } from '../src/enterprise-token-store.ts'
import { saveEnterpriseTokens } from '../src/enterprise-token-store.ts'

const PRESET_ENV = Object.freeze({
  DSH_ENTERPRISE_GATEWAY_URL: 'https://gateway.example.com',
  DSH_ENTERPRISE_OAUTH_CLIENT_ID: 'dsh-desktop',
})

/**
 * The gate drives the real token store (fs) and a real 1s refresher floor, so
 * these tests run on real timers. Pure timing behavior (half-life scheduling,
 * rotation, single-flight) is covered in enterprise-token-refresher.spec.ts
 * with fake timers and in-memory deps.
 */

function reverseProtector(available: boolean | (() => boolean | Promise<boolean>) = true): DesktopLanHttpsPrivateKeyProtector {
  return {
    available,
    seal: (plaintext: Uint8Array) => Buffer.from(plaintext).reverse(),
    open: (sealed: Uint8Array) => Buffer.from(sealed).reverse(),
  }
}

interface WindowEntry {
  readonly inputs: DesktopEnterpriseLoginWindowInput[]
  readonly resolvers: Array<(result: DesktopEnterpriseLoginResult) => void>
}

function fakeWindowFactory() {
  const windows: WindowEntry[] = []
  const createWindow = (options: DesktopEnterpriseLoginWindowOptions): EnterpriseLoginWindowLike => {
    const entry: WindowEntry = {
      inputs: [options.input],
      resolvers: [],
    }
    windows.push(entry)
    return {
      show: () => {},
      showView: (input: DesktopEnterpriseLoginWindowInput) => { entry.inputs.push(input) },
      run: () => new Promise<DesktopEnterpriseLoginResult>(resolve => { entry.resolvers.push(resolve) }),
    }
  }
  const finish = (index: number, result: DesktopEnterpriseLoginResult): void => {
    const entry = windows[index]
    if (entry === undefined) throw new Error(`no fake window ${String(index)}`)
    const resolve = entry.resolvers.shift()
    if (resolve === undefined) throw new Error(`fake window ${String(index)} is not being awaited`)
    resolve(result)
  }
  return { createWindow, windows, finish }
}

interface GateHarnessOptions {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly protector?: DesktopLanHttpsPrivateKeyProtector
}

async function harness({ env = PRESET_ENV, protector = reverseProtector() }: GateHarnessOptions = {}) {
  const userDataDir = await mkdtemp(join(tmpdir(), 'dsh-enterprise-gate-user-'))
  const homeDir = await mkdtemp(join(tmpdir(), 'dsh-enterprise-gate-home-'))
  const fake = fakeWindowFactory()
  const transport = vi.fn(async (_endpoint: string, _form: URLSearchParams) => ({
    status: 200,
    text: JSON.stringify({ access_token: 'access-rotated', refresh_token: 'refresh-rotated', expires_in: 600, token_type: 'Bearer' }),
  }))
  const logger = { error: vi.fn() }
  const patchWriter = vi.fn(async (_homeDir: string, _document: string) => ({ status: 'written' as const }))
  const gate = new DesktopEnterpriseGate({
    userDataDir,
    homeDir,
    locale: 'zh',
    platform: 'linux',
    protector,
    openExternal: () => {},
    copyToClipboard: () => {},
    logger,
    createWindow: fake.createWindow,
    transport,
    env,
    patchWriter,
  })
  return {
    gate,
    fake,
    transport,
    logger,
    patchWriter,
    userDataDir,
    homeDir,
    dispose: async () => {
      gate.dispose()
      await Promise.allSettled([rm(userDataDir, { recursive: true, force: true }), rm(homeDir, { recursive: true, force: true })])
    },
  }
}

function storedTokens(overrides: Partial<EnterpriseTokenSet> = {}): EnterpriseTokenSet {
  const now = Date.now()
  return {
    accessToken: 'access-current',
    refreshToken: 'refresh-current',
    scope: 'openid session llm',
    gatewayUrl: 'https://gateway.example.com',
    clientId: 'dsh-desktop',
    expiresAt: now + 600_000,
    refreshAt: now + 300_000,
    obtainedAt: now - 100,
    ...overrides,
  }
}

describe('desktop enterprise gate', () => {
  it('quits through the preset-missing window when the deployment preset is absent', async () => {
    const { gate, fake, dispose } = await harness({ env: {} })
    try {
      const pending = gate.run()
      await vi.waitFor(() => { expect(fake.windows).toHaveLength(1) })
      expect(fake.windows[0]?.inputs[0]?.view).toBe('preset-missing')
      expect(fake.windows[0]?.inputs[0]?.serverOrigin).toBe('')
      fake.finish(0, { action: 'quit' })
      await expect(pending).resolves.toEqual({ outcome: 'quit' })
    } finally {
      await dispose()
    }
  })

  it('quits through the storage-unavailable window when the protector is unusable', async () => {
    const { gate, fake, dispose } = await harness({ protector: reverseProtector(false) })
    try {
      const pending = gate.run()
      await vi.waitFor(() => { expect(fake.windows).toHaveLength(1) })
      expect(fake.windows[0]?.inputs[0]?.view).toBe('storage-unavailable')
      fake.finish(0, { action: 'quit' })
      await expect(pending).resolves.toEqual({ outcome: 'quit' })
    } finally {
      await dispose()
    }
  })

  it('boots straight through with a valid stored session and installs the machine patch', async () => {
    const { gate, fake, patchWriter, dispose, userDataDir } = await harness()
    try {
      await saveEnterpriseTokens(userDataDir, reverseProtector(), storedTokens())
      await expect(gate.run()).resolves.toEqual({ outcome: 'authenticated' })
      expect(fake.windows).toHaveLength(0)
      expect(patchWriter).toHaveBeenCalledOnce()
      const document = patchWriter.mock.calls[0]?.[1]
      expect(document).toContain('baseURL: "https://gateway.example.com/internal/llm"')
      expect(document).toContain('apiKeyEnv: DSH_LLM_TOKEN')
    } finally {
      await dispose()
    }
  })

  it('silently refreshes an expired access token before showing any window', async () => {
    const { gate, fake, transport, dispose, userDataDir } = await harness()
    try {
      const now = Date.now()
      await saveEnterpriseTokens(userDataDir, reverseProtector(), storedTokens({ expiresAt: now - 1000, refreshAt: now - 2000 }))
      const pending = gate.run()
      await expect(pending).resolves.toEqual({ outcome: 'authenticated' })
      expect(fake.windows).toHaveLength(0)
      const form = transport.mock.calls[0]?.[1]
      expect(form?.get('grant_type')).toBe('refresh_token')
      expect(form?.get('refresh_token')).toBe('refresh-current')
    } finally {
      await dispose()
    }
  })

  it('falls back to the login window when the silent refresh is rejected', async () => {
    const { gate, fake, transport, dispose, userDataDir } = await harness()
    try {
      const now = Date.now()
      await saveEnterpriseTokens(userDataDir, reverseProtector(), storedTokens({ expiresAt: now - 1000, refreshAt: now - 2000 }))
      transport.mockImplementation(async () => ({
        status: 400,
        text: JSON.stringify({ error: 'invalid_grant', error_description: 'family revoked' }),
      }))
      const pending = gate.run()
      await vi.waitFor(() => { expect(fake.windows).toHaveLength(1) })
      expect(fake.windows[0]?.inputs[0]?.view).toBe('initial')
      // The failed session stays stored so a re-login can replace it in place.
      fake.finish(0, { action: 'continue' })
      await expect(pending).resolves.toEqual({ outcome: 'authenticated' })
    } finally {
      await dispose()
    }
  })

  it('treats a session from a different gateway as absent', async () => {
    const { gate, fake, transport, dispose, userDataDir } = await harness()
    try {
      await saveEnterpriseTokens(userDataDir, reverseProtector(), storedTokens({ gatewayUrl: 'https://other.example.com' }))
      const pending = gate.run()
      await vi.waitFor(() => { expect(fake.windows).toHaveLength(1) })
      expect(fake.windows[0]?.inputs[0]?.view).toBe('initial')
      expect(transport).not.toHaveBeenCalled()
      fake.finish(0, { action: 'quit' })
      await expect(pending).resolves.toEqual({ outcome: 'quit' })
    } finally {
      await dispose()
    }
  })

  it('drives the copy-link escape hatch and back-to-initial action', async () => {
    const { fake, dispose } = await harness()
    const userDataDir = await mkdtemp(join(tmpdir(), 'dsh-enterprise-gate-user-'))
    const copied: string[] = []
    let onAction: ((action: 'open-browser' | 'copy-link' | 'retry' | 'back') => void) | undefined
    const gate = new DesktopEnterpriseGate({
      userDataDir,
      homeDir: join(userDataDir, 'home'),
      locale: 'zh',
      platform: 'linux',
      protector: reverseProtector(),
      openExternal: () => {},
      copyToClipboard: text => { copied.push(text) },
      logger: { error: vi.fn() },
      createWindow: (options: DesktopEnterpriseLoginWindowOptions): EnterpriseLoginWindowLike => {
        onAction = options.onAction
        return fake.createWindow(options)
      },
      transport: async () => ({ status: 400, text: '{"error":"invalid_request"}' }),
      env: PRESET_ENV,
      patchWriter: async () => ({ status: 'written' }),
    })
    try {
      const pending = gate.run()
      await vi.waitFor(() => { if (onAction === undefined) throw new Error('window factory did not receive onAction') })
      const trigger = onAction
      if (trigger === undefined) throw new Error('window factory did not receive onAction')
      trigger('open-browser') // starts a real loopback listener attempt
      await vi.waitFor(() => {
        trigger('copy-link')
        expect(copied.length).toBeGreaterThan(0)
      })
      expect(copied[0]).toContain('/api/oauth/authorize')
      trigger('back')
      expect(fake.windows[0]?.inputs.at(-1)?.view).toBe('initial')
      gate.dispose() // tearing down mid-window must not break the result path
      fake.finish(0, { action: 'quit' })
      await expect(pending).resolves.toEqual({ outcome: 'quit' })
    } finally {
      gate.dispose()
      await rm(userDataDir, { recursive: true, force: true })
      await dispose()
    }
  })

  it('reopens re-login with a session-expired notice when maintenance refresh fails', async () => {
    const { gate, fake, transport, logger, dispose, userDataDir } = await harness()
    try {
      // Refresh is scheduled at the stored half-life minus the 1s floor;
      // craft the stored set one second past its half-life point.
      const now = Date.now()
      await saveEnterpriseTokens(userDataDir, reverseProtector(), storedTokens({
        expiresAt: now + 400_000,
        refreshAt: now - 1000,
      }))
      await expect(gate.run()).resolves.toEqual({ outcome: 'authenticated' })
      gate.startMaintenance()
      transport.mockImplementation(async () => {
        throw new EnterpriseOAuthError('invalid_grant', 'family revoked')
      })
      await vi.waitFor(() => { expect(fake.windows).toHaveLength(1) }, { timeout: 5000 })
      expect(fake.windows[0]?.inputs[0]?.view).toBe('initial')
      expect(fake.windows[0]?.inputs[0]?.notice).toBe('session-expired')
      fake.finish(0, { action: 'quit' })
      await vi.waitFor(() => {
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('re-login was dismissed'))
      }, { timeout: 5000 })
      gate.dispose()
    } finally {
      await dispose()
    }
  })

  it('restarts maintenance after a successful re-login from the maintenance flow', async () => {
    const { gate, fake, transport, dispose, userDataDir } = await harness()
    try {
      const now = Date.now()
      await saveEnterpriseTokens(userDataDir, reverseProtector(), storedTokens({
        expiresAt: now + 400_000,
        refreshAt: now - 1000,
      }))
      await expect(gate.run()).resolves.toEqual({ outcome: 'authenticated' })
      gate.startMaintenance()
      transport.mockImplementation(async () => {
        throw new EnterpriseOAuthError('invalid_grant', 'family revoked')
      })
      await vi.waitFor(() => { expect(fake.windows).toHaveLength(1) }, { timeout: 5000 })
      // User completes a fresh login through the window; for this test the
      // window result is resolved directly as authenticated.
      transport.mockImplementation(async () => ({
        status: 200,
        text: JSON.stringify({ access_token: 'a2', refresh_token: 'r2', expires_in: 600, token_type: 'Bearer' }),
      }))
      fake.finish(0, { action: 'continue' })
      // Re-login success restarts maintenance; the next half-life rotation
      // then runs against the (rotated-mock) transport.
      const callsBefore = transport.mock.calls.length
      await vi.waitFor(() => { expect(transport.mock.calls.length).toBeGreaterThan(callsBefore) }, { timeout: 5000 })
      gate.dispose()
    } finally {
      await dispose()
    }
  })
})
