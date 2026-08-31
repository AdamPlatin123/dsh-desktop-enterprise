import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  EnterpriseOAuthError,
  buildEnterpriseAuthorizeUrl,
  createEnterprisePkcePair,
  createEnterpriseState,
  exchangeEnterpriseAuthorizationCode,
  fetchEnterpriseTokenTransport,
  parseEnterpriseIdTokenUsername,
  refreshEnterpriseTokens,
} from '../src/enterprise-oauth.ts'

function okResponse(body: unknown): { status: number, text: string } {
  return { status: 200, text: JSON.stringify(body) }
}

describe('enterprise OAuth client core', () => {
  it('generates PKCE pairs whose challenge is the S256 digest of the verifier', () => {
    const first = createEnterprisePkcePair()
    const second = createEnterprisePkcePair()
    expect(first.verifier).toMatch(/^[A-Za-z0-9_-]{64}$/u)
    expect(first.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(createHash('sha256').update(first.verifier, 'utf8').digest('base64url')).toBe(first.challenge)
    expect(first.verifier).not.toBe(second.verifier)
    expect(first.challenge).not.toBe(second.challenge)
  })

  it('generates unpredictable state values', () => {
    const values = new Set(Array.from({ length: 32 }, () => createEnterpriseState()))
    expect(values.size).toBe(32)
    for (const value of values) expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/u)
  })

  it('builds the authorize URL with the exact server contract parameters', () => {
    const url = new URL(buildEnterpriseAuthorizeUrl({
      gatewayUrl: 'https://gateway.example.com',
      clientId: 'dsh-desktop',
      redirectUri: 'http://127.0.0.1:49152/cb',
      state: 'st4te',
      codeChallenge: 'ch4llenge',
    }))
    expect(url.origin).toBe('https://gateway.example.com')
    expect(url.pathname).toBe('/api/oauth/authorize')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('dsh-desktop')
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:49152/cb')
    expect(url.searchParams.get('scope')).toBe('openid session llm')
    expect(url.searchParams.get('state')).toBe('st4te')
    expect(url.searchParams.get('code_challenge')).toBe('ch4llenge')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  })

  it('exchanges the authorization code with a form-encoded public-client request', async () => {
    const transport = vi.fn(async () => okResponse({
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: 600,
      token_type: 'Bearer',
      id_token: 'h.p.s',
    }))
    const tokens = await exchangeEnterpriseAuthorizationCode(transport, {
      gatewayUrl: 'https://gateway.example.com',
      clientId: 'dsh-desktop',
      code: 'the-code',
      codeVerifier: 'the-verifier',
    })
    expect(transport).toHaveBeenCalledOnce()
    const [endpoint, form] = transport.mock.calls[0] as unknown as [string, URLSearchParams]
    expect(endpoint).toBe('https://gateway.example.com/api/oauth/token')
    expect([...form.keys()].sort()).toEqual(['client_id', 'code', 'code_verifier', 'grant_type'])
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('code')).toBe('the-code')
    expect(form.get('code_verifier')).toBe('the-verifier')
    expect(form.get('client_id')).toBe('dsh-desktop')
    expect(tokens.accessToken).toBe('at')
    expect(tokens.refreshToken).toBe('rt')
    expect(tokens.expiresInSeconds).toBe(600)
  })

  it('refreshes with grant_type=refresh_token and no secret (public client)', async () => {
    const transport = vi.fn(async () => okResponse({
      access_token: 'at2',
      refresh_token: 'rt2',
      expires_in: 300,
    }))
    const tokens = await refreshEnterpriseTokens(transport, {
      gatewayUrl: 'https://gateway.example.com',
      clientId: 'dsh-desktop',
      refreshToken: 'rt-old',
    })
    const [, form] = transport.mock.calls[0] as unknown as [string, URLSearchParams]
    expect(form.get('grant_type')).toBe('refresh_token')
    expect(form.get('refresh_token')).toBe('rt-old')
    expect(form.get('client_id')).toBe('dsh-desktop')
    expect(form.has('code_verifier')).toBe(false)
    expect(tokens.refreshToken).toBe('rt2')
  })

  it('maps RFC 6749 §5.2 errors onto stable client codes', async () => {
    const transport = async (): Promise<{ status: number, text: string }> =>
      ({ status: 400, text: JSON.stringify({ error: 'invalid_grant', error_description: 'code expired' }) })
    await expect(exchangeEnterpriseAuthorizationCode(transport, {
      gatewayUrl: 'https://gateway.example.com',
      clientId: 'dsh-desktop',
      code: 'c',
      codeVerifier: 'v',
    })).rejects.toMatchObject({ code: 'invalid_grant' })

    const serverError = async (): Promise<{ status: number, text: string }> =>
      ({ status: 503, text: 'unavailable' })
    await expect(exchangeEnterpriseAuthorizationCode(serverError, {
      gatewayUrl: 'https://gateway.example.com',
      clientId: 'dsh-desktop',
      code: 'c',
      codeVerifier: 'v',
    })).rejects.toMatchObject({ code: 'server_error' })

    const clientError = async (): Promise<{ status: number, text: string }> =>
      ({ status: 401, text: JSON.stringify({ error: 'invalid_client' }) })
    await expect(refreshEnterpriseTokens(clientError, {
      gatewayUrl: 'https://gateway.example.com',
      clientId: 'dsh-desktop',
      refreshToken: 'rt',
    })).rejects.toMatchObject({ code: 'invalid_client' })
  })

  it('rejects malformed success bodies and transport failures with typed errors', async () => {
    const noAccessToken = async (): Promise<{ status: number, text: string }> =>
      okResponse({ refresh_token: 'rt', expires_in: 10 })
    await expect(exchangeEnterpriseAuthorizationCode(noAccessToken, {
      gatewayUrl: 'https://gateway.example.com',
      clientId: 'dsh-desktop',
      code: 'c',
      codeVerifier: 'v',
    })).rejects.toBeInstanceOf(EnterpriseOAuthError)

    const badExpires = async (): Promise<{ status: number, text: string }> =>
      okResponse({ access_token: 'a', refresh_token: 'r', expires_in: 'soon' })
    await expect(exchangeEnterpriseAuthorizationCode(badExpires, {
      gatewayUrl: 'https://gateway.example.com',
      clientId: 'dsh-desktop',
      code: 'c',
      codeVerifier: 'v',
    })).rejects.toMatchObject({ code: 'malformed_response' })

    const networkFailure = async (): Promise<never> => {
      throw new Error('socket down')
    }
    await expect(exchangeEnterpriseAuthorizationCode(networkFailure, {
      gatewayUrl: 'https://gateway.example.com',
      clientId: 'dsh-desktop',
      code: 'c',
      codeVerifier: 'v',
    })).rejects.toMatchObject({ code: 'network' })
  })

  it('sends the default transport as an exact form-urlencoded POST', async () => {
    const requests: Array<{ readonly url: string, readonly init: RequestInit }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init: init ?? {} })
      return new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 5 }), { status: 200 })
    }) as typeof fetch
    try {
      const tokens = await fetchEnterpriseTokenTransport('https://gateway.example.com/api/oauth/token',
        new URLSearchParams({ grant_type: 'refresh_token' }))
      expect(tokens.status).toBe(200)
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://gateway.example.com/api/oauth/token')
    expect(requests[0]?.init.method).toBe('POST')
    expect(requests[0]?.init.headers).toMatchObject({ 'content-type': 'application/x-www-form-urlencoded' })
    expect(String(requests[0]?.init.body)).toBe('grant_type=refresh_token')
  })

  it('parses the display username from an id_token payload without trusting it', () => {
    const payload = (claims: Record<string, unknown>): string =>
      `h.${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}.s`
    expect(parseEnterpriseIdTokenUsername(payload({ username: 'member', sub: 'u1' }))).toBe('member')
    expect(parseEnterpriseIdTokenUsername(payload({ sub: 'u1' }))).toBeUndefined()
    expect(parseEnterpriseIdTokenUsername('not-a-jwt')).toBeUndefined()
    expect(parseEnterpriseIdTokenUsername(undefined)).toBeUndefined()
  })
})
