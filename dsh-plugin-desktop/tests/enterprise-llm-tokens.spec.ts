import { describe, expect, it, vi } from 'vitest'
import {
  EnterpriseLlmTokenError,
  enterpriseLlmTokenEndpoint,
  fetchEnterpriseLlmTokenTransport,
  issueEnterpriseLlmToken,
  type EnterpriseLlmTokenTransport,
} from '../src/enterprise-llm-tokens.ts'

const GATEWAY = 'https://gateway.example.com'

function ok(text: string): { status: number, text: string } {
  return { status: 200, text }
}

describe('enterprise llm token client', () => {
  it('builds the exact gateway issuance endpoint', () => {
    expect(enterpriseLlmTokenEndpoint('https://gateway.example.com')).toBe(`${GATEWAY}/api/llm/tokens`)
    expect(enterpriseLlmTokenEndpoint(`${GATEWAY}/`)).toBe(`${GATEWAY}/api/llm/tokens`)
  })

  it('issues with an exact bearer POST and no body', async () => {
    const transport = vi.fn(async (): Promise<{ status: number, text: string }> => ok(JSON.stringify({
      token: 'v1.abc',
      expiresAt: 5_000_000,
      generation: 7,
      kind: 'desktop',
    })))
    const token = await issueEnterpriseLlmToken(transport as EnterpriseLlmTokenTransport, {
      gatewayUrl: GATEWAY,
      accessToken: 'oauth-access-token',
    })
    expect(transport).toHaveBeenCalledOnce()
    const [endpoint, init] = transport.mock.calls[0] as unknown as [string, { method: string, headers: Record<string, string> }]
    expect(endpoint).toBe(`${GATEWAY}/api/llm/tokens`)
    expect(init.method).toBe('POST')
    expect(init.headers.authorization).toBe('Bearer oauth-access-token')
    expect(token).toEqual({ token: 'v1.abc', expiresAt: 5_000_000, generation: 7 })
  })

  it('accepts a success body without a generation field', async () => {
    const transport = vi.fn(async () => ok(JSON.stringify({ token: 'v1.def', expiresAt: 123 })))
    const token = await issueEnterpriseLlmToken(transport as EnterpriseLlmTokenTransport, { gatewayUrl: GATEWAY, accessToken: 'a' })
    expect(token.generation).toBeUndefined()
    expect(token.token).toBe('v1.def')
  })

  it('maps RFC 6750 rejections onto stable client codes', async () => {
    const unauthorized = async (): Promise<{ status: number, text: string }> =>
      ({ status: 401, text: JSON.stringify({ error: 'invalid_token' }) })
    await expect(issueEnterpriseLlmToken(unauthorized, { gatewayUrl: GATEWAY, accessToken: 'a' }))
      .rejects.toMatchObject({ code: 'unauthorized', serverCode: 'invalid_token' })

    const insufficientScope = async (): Promise<{ status: number, text: string }> =>
      ({ status: 403, text: JSON.stringify({ error: 'insufficient_scope' }) })
    await expect(issueEnterpriseLlmToken(insufficientScope, { gatewayUrl: GATEWAY, accessToken: 'a' }))
      .rejects.toMatchObject({ code: 'insufficient_scope' })

    const unavailable = async (): Promise<{ status: number, text: string }> =>
      ({ status: 503, text: 'temporarily overloaded' })
    await expect(issueEnterpriseLlmToken(unavailable, { gatewayUrl: GATEWAY, accessToken: 'a' }))
      .rejects.toMatchObject({ code: 'unavailable' })

    const otherHttp = async (): Promise<{ status: number, text: string }> =>
      ({ status: 500, text: JSON.stringify({ error: 'internal' }) })
    await expect(issueEnterpriseLlmToken(otherHttp, { gatewayUrl: GATEWAY, accessToken: 'a' }))
      .rejects.toMatchObject({ code: 'http', serverCode: 'internal' })
  })

  it('maps the weak-binding 409 onto the heartbeat_stale code', async () => {
    // R39: the gateway defers renewal until a fresher projection report
    // arrives. The error is typed so the chain can retry at its next
    // half-life instead of tearing the session down.
    const stale = async (): Promise<{ status: number, text: string }> =>
      ({ status: 409, text: JSON.stringify({ error: 'heartbeat_stale', message: 'report pending' }) })
    const failure = await issueEnterpriseLlmToken(stale, { gatewayUrl: GATEWAY, accessToken: 'a' })
      .catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(EnterpriseLlmTokenError)
    expect(failure).toMatchObject({ code: 'heartbeat_stale', serverCode: 'heartbeat_stale' })

    // A 409 without the stable server code stays a generic HTTP failure.
    const bareConflict = async (): Promise<{ status: number, text: string }> =>
      ({ status: 409, text: JSON.stringify({ error: 'conflict' }) })
    await expect(issueEnterpriseLlmToken(bareConflict, { gatewayUrl: GATEWAY, accessToken: 'a' }))
      .rejects.toMatchObject({ code: 'http', serverCode: 'conflict' })
  })

  it('rejects malformed success bodies with a typed error', async () => {
    for (const text of ['not json', 'null', '[1,2]', '{"expiresAt": 5}', '{"token": ""}', '{"token": "t", "expiresAt": "soon"}']) {
      const transport = async (): Promise<{ status: number, text: string }> => ok(text)
      await expect(issueEnterpriseLlmToken(transport, { gatewayUrl: GATEWAY, accessToken: 'a' }))
        .rejects.toBeInstanceOf(EnterpriseLlmTokenError)
    }
  })

  it('maps transport failures onto the network code', async () => {
    const transport = async (): Promise<never> => {
      throw new Error('ECONNREFUSED')
    }
    await expect(issueEnterpriseLlmToken(transport, { gatewayUrl: GATEWAY, accessToken: 'a' }))
      .rejects.toMatchObject({ code: 'network' })
  })

  it('sends the default transport as an exact POST without a body', async () => {
    const requests: Array<{ readonly url: string, readonly init: RequestInit }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init: init ?? {} })
      return new Response(JSON.stringify({ token: 'v1.x', expiresAt: 9 }), { status: 201 })
    }) as typeof fetch
    try {
      const result = await fetchEnterpriseLlmTokenTransport(`${GATEWAY}/api/llm/tokens`, {
        method: 'POST',
        headers: { authorization: 'Bearer a' },
      })
      expect(result.status).toBe(201)
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe(`${GATEWAY}/api/llm/tokens`)
    expect(requests[0]?.init.method).toBe('POST')
    expect(requests[0]?.init.headers).toMatchObject({ authorization: 'Bearer a' })
    expect(requests[0]?.init.body).toBeUndefined()
  })

  it('wraps default-transport network failures in the typed error', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (): Promise<Response> => {
      throw new Error('network down')
    }) as typeof fetch
    try {
      await expect(fetchEnterpriseLlmTokenTransport(`${GATEWAY}/api/llm/tokens`, {
        method: 'POST',
        headers: {},
      })).rejects.toBeInstanceOf(EnterpriseLlmTokenError)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
