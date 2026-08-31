import { describe, expect, it, vi } from 'vitest'
import {
  EnterpriseIdentityError,
  enterpriseRoleBadge,
  enterpriseUserinfoEndpoint,
  fetchEnterpriseIdentity,
  fetchEnterpriseIdentityTransport,
  type EnterpriseIdentityTransport,
} from '../src/enterprise-identity.ts'

const GATEWAY = 'https://gateway.example.com'

describe('enterprise identity projection', () => {
  it('builds the exact userinfo endpoint and reads with a bearer GET', async () => {
    const transport = vi.fn(async () => ({
      status: 200,
      text: JSON.stringify({ sub: 'u-123', username: 'alice', role: 'admin' }),
    }))
    const identity = await fetchEnterpriseIdentity(transport as EnterpriseIdentityTransport, {
      gatewayUrl: GATEWAY,
      accessToken: 'oauth-access-token',
    })
    expect(enterpriseUserinfoEndpoint(GATEWAY)).toBe(`${GATEWAY}/api/oauth/userinfo`)
    expect(transport).toHaveBeenCalledOnce()
    const [endpoint, init] = transport.mock.calls[0] as unknown as [string, { method: string, headers: Record<string, string> }]
    expect(endpoint).toBe(`${GATEWAY}/api/oauth/userinfo`)
    expect(init.method).toBe('GET')
    expect(init.headers.authorization).toBe('Bearer oauth-access-token')
    expect(identity).toEqual({ username: 'alice', role: 'admin' })
  })

  it('maps a session rejection and server faults onto stable codes', async () => {
    const unauthorized = async (): Promise<{ status: number, text: string }> =>
      ({ status: 401, text: JSON.stringify({ error: 'invalid_token' }) })
    await expect(fetchEnterpriseIdentity(unauthorized, { gatewayUrl: GATEWAY, accessToken: 'a' }))
      .rejects.toMatchObject({ code: 'unauthorized' })

    const serverFault = async (): Promise<{ status: number, text: string }> => ({ status: 500, text: 'boom' })
    await expect(fetchEnterpriseIdentity(serverFault, { gatewayUrl: GATEWAY, accessToken: 'a' }))
      .rejects.toMatchObject({ code: 'http' })
  })

  it('rejects malformed or overlong identity bodies', async () => {
    for (const text of ['not json', 'null', '{"role": "admin"}', '{"username": "a", "role": ""}', `{"username": "${'x'.repeat(257)}", "role": "admin"}`]) {
      const transport = async (): Promise<{ status: number, text: string }> => ({ status: 200, text })
      await expect(fetchEnterpriseIdentity(transport, { gatewayUrl: GATEWAY, accessToken: 'a' }))
        .rejects.toBeInstanceOf(EnterpriseIdentityError)
    }
  })

  it('maps transport failures onto the network code', async () => {
    const transport = async (): Promise<never> => {
      throw new Error('dns failure')
    }
    await expect(fetchEnterpriseIdentity(transport, { gatewayUrl: GATEWAY, accessToken: 'a' }))
      .rejects.toMatchObject({ code: 'network' })
  })

  it('bounds every server role onto a known badge', () => {
    expect(enterpriseRoleBadge('admin')).toBe('admin')
    expect(enterpriseRoleBadge('member')).toBe('member')
    expect(enterpriseRoleBadge('auditor')).toBe('member')
    expect(enterpriseRoleBadge('')).toBe('member')
  })

  it('sends the default transport as an exact GET with no body', async () => {
    const requests: Array<{ readonly url: string, readonly init: RequestInit }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init: init ?? {} })
      return new Response(JSON.stringify({ username: 'bob', role: 'member' }), { status: 200 })
    }) as typeof fetch
    try {
      const result = await fetchEnterpriseIdentityTransport(`${GATEWAY}/api/oauth/userinfo`, {
        method: 'GET',
        headers: { authorization: 'Bearer a' },
      })
      expect(result.status).toBe(200)
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(requests).toHaveLength(1)
    expect(requests[0]?.init.method).toBe('GET')
    expect(requests[0]?.init.headers).toMatchObject({ authorization: 'Bearer a' })
  })
})
