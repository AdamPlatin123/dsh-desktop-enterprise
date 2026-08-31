import { describe, expect, it, vi } from 'vitest'
import { EnterpriseLoginCoordinator, type EnterpriseLoginUi } from '../src/enterprise-login-coordinator.ts'
import { EnterpriseLoopbackError, EnterpriseLoopbackListener, type EnterpriseLoopbackCallback, type EnterpriseLoopbackListenerOptions } from '../src/enterprise-loopback-callback.ts'
import { EnterpriseTokenStoreError, type EnterpriseTokenSet } from '../src/enterprise-token-store.ts'

type TokenTransport = (endpoint: string, form: URLSearchParams) => Promise<{ status: number, text: string }>

function flush(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, 0) })
}

function fakeListenerFactory() {
  const resolvers: Array<(outcome: EnterpriseLoopbackCallback) => void> = []
  const rejecters: Array<(cause: EnterpriseLoopbackError) => void> = []
  let disposedCount = 0
  const start = async (_options: EnterpriseLoopbackListenerOptions) => ({
    port: 49152,
    redirectUri: 'http://127.0.0.1:49152/cb',
    waitForCallback: (): Promise<EnterpriseLoopbackCallback> => new Promise((resolve, reject) => {
      resolvers.push(resolve)
      rejecters.push(reject)
    }),
    dispose: () => {
      disposedCount += 1
      // Mirrors the real listener: disposal rejects pending waiters.
      const pendingRejecters = rejecters.splice(0)
      for (const reject of pendingRejecters) reject(new EnterpriseLoopbackError('disposed', 'listener disposed'))
      resolvers.length = 0
    },
  })
  return {
    start,
    deliver: (outcome: EnterpriseLoopbackCallback): void => {
      const resolve = resolvers.pop()
      if (resolve === undefined) throw new Error('no pending waitForCallback')
      resolve(outcome)
    },
    reject: (cause: EnterpriseLoopbackError): void => {
      const rejectFn = rejecters.pop()
      if (rejectFn === undefined) throw new Error('no pending waitForCallback')
      rejectFn(cause)
    },
    disposedCount: () => disposedCount,
  }
}

function idTokenWithUsername(username: string): string {
  return `h.${Buffer.from(JSON.stringify({ username, sub: 'u-1' }), 'utf8').toString('base64url')}.s`
}

interface HarnessOptions {
  readonly persistError?: Error
  readonly transport?: TokenTransport
}

function harness({ persistError, transport }: HarnessOptions = {}) {
  const fake = fakeListenerFactory()
  const views: Array<{ view: string, context?: { readonly username?: string, readonly errorMessage?: string } }> = []
  const ui: EnterpriseLoginUi = {
    show: (view, context) => { views.push({ view, ...(context === undefined ? {} : { context }) }) },
  }
  const openedUrls: string[] = []
  const persisted: EnterpriseTokenSet[] = []
  const tokenTransport = vi.fn(transport ?? (async () => ({
    status: 200,
    text: JSON.stringify({
      access_token: 'access-new',
      refresh_token: 'refresh-new',
      expires_in: 600,
      token_type: 'Bearer',
      id_token: idTokenWithUsername('member'),
    }),
  })))
  const coordinator = new EnterpriseLoginCoordinator({
    locale: 'zh',
    gatewayUrl: 'https://gateway.example.com',
    clientId: 'dsh-desktop',
    scope: 'openid session llm',
    timeoutMs: 5 * 60 * 1000,
    transport: tokenTransport,
    openBrowser: url => { openedUrls.push(url) },
    startListener: fake.start as unknown as typeof EnterpriseLoopbackListener.start,
    persistTokens: async tokens => {
      if (persistError !== undefined) throw persistError
      persisted.push(tokens)
    },
    now: () => 1_000_000,
  }, ui)
  return { coordinator, views, openedUrls, persisted, fake, tokenTransport }
}

/** Extract the state the coordinator embedded in its (last) authorize URL. */
async function stateFromAuthorizeUrl(openedUrls: readonly string[]): Promise<string> {
  const url = openedUrls[openedUrls.length - 1]
  if (url === undefined) throw new Error('no authorize URL was opened')
  return new URL(url).searchParams.get('state') ?? ''
}

describe('enterprise login coordinator', () => {
  it('runs browser handoff, state check, exchange, and persistence into success', async () => {
    const { coordinator, views, openedUrls, persisted, fake, tokenTransport } = harness()
    const pending = coordinator.attempt()
    await flush()
    expect(openedUrls).toHaveLength(1)
    const authorizeUrl = new URL(openedUrls[0] as string)
    expect(authorizeUrl.pathname).toBe('/api/oauth/authorize')
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:49152/cb')
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(fake.disposedCount()).toBe(0)
    fake.deliver({
      kind: 'success',
      code: 'the-code',
      state: authorizeUrl.searchParams.get('state') ?? '',
    })
    await expect(pending).resolves.toBe('authenticated')
    expect(views.map(entry => entry.view)).toEqual(['waiting', 'success'])
    expect(views[1]?.context?.username).toBe('member')
    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toMatchObject({
      accessToken: 'access-new',
      refreshToken: 'refresh-new',
      gatewayUrl: 'https://gateway.example.com',
      clientId: 'dsh-desktop',
      scope: 'openid session llm',
      username: 'member',
    })
    const form = tokenTransport.mock.calls[0]?.[1] as URLSearchParams
    expect(form.get('code')).toBe('the-code')
    expect(form.get('grant_type')).toBe('authorization_code')
  })

  it('merges concurrent attempts into a single flow', async () => {
    const { coordinator, openedUrls } = harness()
    const first = coordinator.attempt()
    const second = coordinator.attempt()
    expect(first).toBe(second)
    await flush()
    expect(openedUrls).toHaveLength(1)
    coordinator.dispose()
  })

  it('maps access_denied to the denied state without touching the token endpoint', async () => {
    const { coordinator, views, fake, tokenTransport } = harness()
    const pending = coordinator.attempt()
    await flush()
    fake.deliver({ kind: 'error', error: 'access_denied', state: 'whatever' })
    await expect(pending).resolves.toBe('denied')
    expect(views.at(-1)?.view).toBe('denied')
    expect(tokenTransport).not.toHaveBeenCalled()
  })

  it('surfaces non-denied authorization errors as failures', async () => {
    const { coordinator, views, fake } = harness()
    const pending = coordinator.attempt()
    await flush()
    fake.deliver({ kind: 'error', error: 'server_error', errorDescription: 'backend down' })
    await expect(pending).resolves.toBe('failed')
    expect(views.at(-1)).toMatchObject({ view: 'error', context: { errorMessage: 'server_error' } })
  })

  it('drops a state-mismatched redirect before any exchange (red line)', async () => {
    const { coordinator, views, fake, tokenTransport } = harness()
    const pending = coordinator.attempt()
    await flush()
    fake.deliver({ kind: 'success', code: 'stolen-code', state: 'not-the-state' })
    await expect(pending).resolves.toBe('failed')
    expect(tokenTransport).not.toHaveBeenCalled()
    expect(views.at(-1)?.view).toBe('error')
  })

  it('times out into the timeout state when no redirect arrives', async () => {
    const { coordinator, views, fake } = harness()
    const pending = coordinator.attempt()
    await flush()
    fake.reject(new EnterpriseLoopbackError('timeout', 'no redirect'))
    await expect(pending).resolves.toBe('timeout')
    expect(views.at(-1)?.view).toBe('timeout')
  })

  it('reports superseded when disposed mid-attempt', async () => {
    const { coordinator, fake } = harness()
    const pending = coordinator.attempt()
    await flush()
    coordinator.dispose()
    await expect(pending).resolves.toBe('superseded')
    expect(fake.disposedCount()).toBeGreaterThan(0)
  })

  it('maps token-exchange failures to the localized error view', async () => {
    const { coordinator, views, openedUrls, fake } = harness({
      transport: async () => ({
        status: 400,
        text: JSON.stringify({ error: 'invalid_grant', error_description: 'code expired' }),
      }),
    })
    const pending = coordinator.attempt()
    await flush()
    const state = await stateFromAuthorizeUrl(openedUrls)
    fake.deliver({ kind: 'success', code: 'c', state })
    await expect(pending).resolves.toBe('failed')
    expect(views.at(-1)?.view).toBe('error')
    expect(views.at(-1)?.context?.errorMessage).toContain('invalid_grant')
  })

  it('shows the storage-unavailable view when persistence cannot protect tokens', async () => {
    const { coordinator, views, openedUrls, fake } = harness({
      persistError: new EnterpriseTokenStoreError('storage-unavailable', 'no keyring'),
    })
    const pending = coordinator.attempt()
    await flush()
    const state = await stateFromAuthorizeUrl(openedUrls)
    fake.deliver({ kind: 'success', code: 'c', state })
    await expect(pending).resolves.toBe('failed')
    expect(views.at(-1)?.view).toBe('storage-unavailable')
  })
})
