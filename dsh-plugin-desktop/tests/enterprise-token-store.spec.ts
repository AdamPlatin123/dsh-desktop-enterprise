import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { DesktopLanHttpsPrivateKeyProtector } from '../src/lan-https-certificate.ts'
import {
  EnterpriseTokenStoreError,
  clearEnterpriseTokens,
  enterpriseTokenSchedule,
  enterpriseTokenStorePath,
  enterpriseTokenValidity,
  readEnterpriseTokens,
  saveEnterpriseTokens,
} from '../src/enterprise-token-store.ts'

function reverseProtector(available: boolean | (() => boolean | Promise<boolean>) = true): DesktopLanHttpsPrivateKeyProtector {
  return {
    available,
    seal: (plaintext: Uint8Array) => Buffer.from(plaintext).reverse(),
    open: (sealed: Uint8Array) => Buffer.from(sealed).reverse(),
  }
}

const sampleTokens = Object.freeze({
  accessToken: 'access-token-1',
  refreshToken: 'refresh-token-1',
  scope: 'openid session llm',
  gatewayUrl: 'https://gateway.example.com',
  clientId: 'dsh-desktop',
  username: 'member',
  expiresAt: 1000,
  refreshAt: 500,
  obtainedAt: 0,
})

async function tempUserData(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-enterprise-tokens-'))
}

describe('enterprise token schedule and validity', () => {
  it('derives the refresh point at half the access-token lifetime', () => {
    expect(enterpriseTokenSchedule(600, 1_000_000)).toEqual({ expiresAt: 1_600_000, refreshAt: 1_300_000 })
    expect(() => enterpriseTokenSchedule(0, 0)).toThrow(TypeError)
    expect(() => enterpriseTokenSchedule(Number.NaN, 0)).toThrow(TypeError)
  })

  it('projects validity without locally expiring the refresh token', () => {
    const valid = enterpriseTokenValidity({ ...sampleTokens }, 900)
    expect(valid).toEqual({ accessValid: true, refreshable: true, sessionUsable: true })
    // Expired access token but a live refresh token keeps the session usable.
    const stale = enterpriseTokenValidity({ ...sampleTokens }, 2000)
    expect(stale).toEqual({ accessValid: false, refreshable: true, sessionUsable: true })
  })
})

describe('enterprise token store persistence', () => {
  it('rejects non-absolute userData paths up front', () => {
    expect(() => enterpriseTokenStorePath('relative/path')).toThrow(EnterpriseTokenStoreError)
  })

  it('round-trips the token set through the protector and reports absence when empty', async () => {
    const userData = await tempUserData()
    try {
      expect(await readEnterpriseTokens(userData, reverseProtector())).toBeUndefined()
      await saveEnterpriseTokens(userData, reverseProtector(), sampleTokens)
      const readBack = await readEnterpriseTokens(userData, reverseProtector())
      expect(readBack).toEqual(sampleTokens)
      await clearEnterpriseTokens(userData)
      expect(await readEnterpriseTokens(userData, reverseProtector())).toBeUndefined()
    } finally {
      await rm(userData, { recursive: true, force: true })
    }
  })

  it('persists only the sealed blob with private directory and file modes', async () => {
    const userData = await tempUserData()
    try {
      await saveEnterpriseTokens(userData, reverseProtector(), sampleTokens)
      const directoryInfo = await stat(join(userData, 'enterprise-auth'))
      expect(directoryInfo.isDirectory()).toBe(true)
      expect(directoryInfo.mode & 0o777).toBe(0o700)
      const fileInfo = await stat(join(userData, 'enterprise-auth', 'tokens.json'))
      expect(fileInfo.isFile()).toBe(true)
      expect(fileInfo.mode & 0o777).toBe(0o600)
      const raw = await readFile(join(userData, 'enterprise-auth', 'tokens.json'), 'utf8')
      expect(raw).not.toContain('access-token-1')
      expect(raw).not.toContain('refresh-token-1')
      const parsed = JSON.parse(raw) as { version: number, sealed: string }
      expect(Object.keys(parsed).sort()).toEqual(['sealed', 'version'])
      expect(parsed.version).toBe(1)
    } finally {
      await rm(userData, { recursive: true, force: true })
    }
  })

  it('fails closed on tampered or unreadable state files', async () => {
    const userData = await tempUserData()
    try {
      const stateDirectory = join(userData, 'enterprise-auth')
      await saveEnterpriseTokens(userData, reverseProtector(), sampleTokens)
      const statePath = join(stateDirectory, 'tokens.json')
      await writeFile(statePath, '{not json', { mode: 0o600 })
      await expect(readEnterpriseTokens(userData, reverseProtector()))
        .rejects.toMatchObject({ code: 'storage-state' })

      await writeFile(statePath, JSON.stringify({ version: 1, sealed: Buffer.from('opaque ciphertext').toString('base64') }), { mode: 0o600 })
      // A sealed blob that the protector cannot open surfaces as storage-unavailable.
      const throwing = {
        available: true,
        seal: (plaintext: Uint8Array) => Buffer.from(plaintext).reverse(),
        open: () => { throw new Error('keyring migrated') },
      }
      await expect(readEnterpriseTokens(userData, throwing)).rejects.toMatchObject({ code: 'storage-unavailable' })
    } finally {
      await rm(userData, { recursive: true, force: true })
    }
  })

  it('refuses to operate when the protector is unavailable', async () => {
    const userData = await tempUserData()
    try {
      await expect(readEnterpriseTokens(userData, reverseProtector(false)))
        .rejects.toMatchObject({ code: 'storage-unavailable' })
      await expect(saveEnterpriseTokens(userData, reverseProtector(false), sampleTokens))
        .rejects.toMatchObject({ code: 'storage-unavailable' })
    } finally {
      await rm(userData, { recursive: true, force: true })
    }
  })

  it('refuses a protector that fails to conceal the token set', async () => {
    const userData = await tempUserData()
    const identity: DesktopLanHttpsPrivateKeyProtector = {
      available: true,
      seal: (plaintext: Uint8Array) => Buffer.from(plaintext),
      open: (sealed: Uint8Array) => Buffer.from(sealed),
    }
    try {
      await expect(saveEnterpriseTokens(userData, identity, sampleTokens))
        .rejects.toMatchObject({ code: 'storage-unavailable' })
    } finally {
      await rm(userData, { recursive: true, force: true })
    }
  })
})
