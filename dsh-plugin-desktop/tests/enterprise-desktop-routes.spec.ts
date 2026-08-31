import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_ENTERPRISE_IDENTITY_PATH,
  DESKTOP_ENTERPRISE_REAUTH_PATH,
  DESKTOP_ENTERPRISE_SIGNOUT_PATH,
  handleDesktopEnterpriseIdentityRequest,
  handleDesktopEnterpriseReauthRequest,
  handleDesktopEnterpriseSignoutRequest,
  isSameOriginEnterpriseRequest,
  type DesktopEnterpriseSurface,
} from '../src/enterprise-desktop-routes.ts'

const ORIGIN = 'http://127.0.0.1:43120'

interface RequestOptions {
  readonly body?: string | Buffer
  readonly headers?: Readonly<Record<string, string | undefined>>
  readonly remoteAddress?: string
}

function request(method: string, options: RequestOptions = {}): IncomingMessage {
  const req = Readable.from(options.body === undefined ? [] : [options.body]) as IncomingMessage
  req.method = method
  req.headers = {
    host: '127.0.0.1:43120',
    origin: ORIGIN,
    'sec-fetch-site': 'same-origin',
    ...options.headers,
  }
  Object.defineProperty(req, 'socket', {
    configurable: true,
    value: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
  })
  return req
}

function response(): ServerResponse & {
  body: string
  end: ReturnType<typeof vi.fn>
  setHeader: ReturnType<typeof vi.fn>
} {
  const res = {
    body: '',
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn((body?: string) => { res.body = body ?? '' }),
  }
  return res as unknown as ServerResponse & typeof res
}

function surface(overrides: Partial<DesktopEnterpriseSurface> = {}): DesktopEnterpriseSurface {
  const identity = vi.fn(() => ({ username: 'alice', role: 'admin' }))
  const signout = vi.fn(async () => {})
  const reauth = vi.fn(async () => {})
  return { identity, signout, reauth, ...overrides }
}

describe('desktop enterprise HTTP boundary', () => {
  it('projects the signed-in identity for the settings-page account area', async () => {
    const enterprise = surface()
    const res = response()
    await handleDesktopEnterpriseIdentityRequest(request('GET'), res, ORIGIN, enterprise)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ username: 'alice', role: 'admin' })
    expect(res.setHeader).toHaveBeenCalledWith('cache-control', 'no-store')
    expect(res.setHeader).toHaveBeenCalledWith('x-content-type-options', 'nosniff')
  })

  it('answers 404 on the identity route while no session is established', async () => {
    const enterprise = surface({ identity: vi.fn(() => undefined) })
    const res = response()
    await handleDesktopEnterpriseIdentityRequest(request('GET'), res, ORIGIN, enterprise)
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toEqual({ error: 'no enterprise session' })
  })

  it('rejects non-GET identity requests before reading the identity', async () => {
    const enterprise = surface()
    const res = response()
    await handleDesktopEnterpriseIdentityRequest(request('POST'), res, ORIGIN, enterprise)
    expect(res.statusCode).toBe(405)
    expect(res.setHeader).toHaveBeenCalledWith('allow', 'GET')
    expect(enterprise.identity).not.toHaveBeenCalled()
  })

  it('accepts an empty sign-out request, acknowledges it, and runs the gate chain', async () => {
    const enterprise = surface()
    const res = response()
    await handleDesktopEnterpriseSignoutRequest(request('POST', { headers: { 'content-length': '0' } }), res, ORIGIN, enterprise)
    expect(res.statusCode).toBe(202)
    expect(JSON.parse(res.body)).toEqual({ accepted: true })
    expect(enterprise.signout).toHaveBeenCalledOnce()
  })

  it('accepts a re-login request the same way', async () => {
    const enterprise = surface()
    const res = response()
    await handleDesktopEnterpriseReauthRequest(request('POST'), res, ORIGIN, enterprise)
    expect(res.statusCode).toBe(202)
    expect(JSON.parse(res.body)).toEqual({ accepted: true })
    expect(enterprise.reauth).toHaveBeenCalledOnce()
  })

  it('rejects a sign-out or re-login request that declares a body', async () => {
    const enterprise = surface()
    const withBody = response()
    await handleDesktopEnterpriseSignoutRequest(
      request('POST', { body: '{"unexpected": true}', headers: { 'content-length': '18' } }), withBody, ORIGIN, enterprise,
    )
    expect(withBody.statusCode).toBe(400)
    expect(enterprise.signout).not.toHaveBeenCalled()

    const reauthWithBody = response()
    await handleDesktopEnterpriseReauthRequest(
      request('POST', { body: 'x', headers: { 'content-length': '1' } }), reauthWithBody, ORIGIN, enterprise,
    )
    expect(reauthWithBody.statusCode).toBe(400)
    expect(enterprise.reauth).not.toHaveBeenCalled()
  })

  it('keeps actions GET-free and cross-origin traffic out', async () => {
    const enterprise = surface()
    const wrongMethod = response()
    await handleDesktopEnterpriseSignoutRequest(request('GET'), wrongMethod, ORIGIN, enterprise)
    expect(wrongMethod.statusCode).toBe(405)
    expect(res_allow(wrongMethod)).toBe('POST')

    const crossOrigin = response()
    await handleDesktopEnterpriseSignoutRequest(
      request('POST', { headers: { origin: 'https://example.com' } }), crossOrigin, ORIGIN, enterprise,
    )
    expect(crossOrigin.statusCode).toBe(403)
    expect(enterprise.signout).not.toHaveBeenCalled()

    const crossOriginRead = response()
    await handleDesktopEnterpriseIdentityRequest(
      request('GET', { headers: { origin: 'https://example.com' } }), crossOriginRead, ORIGIN, enterprise,
    )
    expect(crossOriginRead.statusCode).toBe(403)

    const nonLoopback = response()
    await handleDesktopEnterpriseIdentityRequest(
      request('GET', { remoteAddress: '192.0.2.10' }), nonLoopback, ORIGIN, enterprise,
    )
    expect(nonLoopback.statusCode).toBe(403)
    expect(enterprise.identity).not.toHaveBeenCalled()
  })

  it('lets an action proceed even when the gate reports a failure of its own', async () => {
    const enterprise = surface({ signout: vi.fn(async () => { throw new Error('revocation endpoint down') }) })
    const res = response()
    await handleDesktopEnterpriseSignoutRequest(request('POST'), res, ORIGIN, enterprise)
    expect(res.statusCode).toBe(202)
    expect(JSON.parse(res.body)).toEqual({ accepted: true })
  })

  it('applies the same-origin rule exactly as the settings API', () => {
    const okReq = request('POST')
    expect(isSameOriginEnterpriseRequest(okReq, ORIGIN, true)).toBe(true)

    // A browser GET without an Origin header needs both fetch-metadata signals.
    const noOriginGet = request('GET', { headers: { origin: undefined, referer: `${ORIGIN}/settings` } })
    expect(isSameOriginEnterpriseRequest(noOriginGet, ORIGIN, false)).toBe(true)
    // Mutating requests always need the exact Origin header.
    expect(isSameOriginEnterpriseRequest(noOriginGet, ORIGIN, true)).toBe(false)
    expect(isSameOriginEnterpriseRequest(
      request('GET', { headers: { origin: undefined } }), ORIGIN, false,
    )).toBe(false)

    const wrongPath = request('GET', { headers: { origin: 'http://127.0.0.1:43120/settings', referer: `${ORIGIN}/settings` } })
    expect(isSameOriginEnterpriseRequest(wrongPath, ORIGIN, false)).toBe(true)

    // An https upgrade of the Origin never matches by itself; the exact
    // http referer plus same-site metadata still proves the read same-origin.
    const upgraded = request('GET', { headers: { origin: 'https://127.0.0.1:43120', referer: `${ORIGIN}/settings` } })
    expect(isSameOriginEnterpriseRequest(upgraded, ORIGIN, false)).toBe(true)
    expect(isSameOriginEnterpriseRequest(
      request('GET', { headers: { origin: 'https://127.0.0.1:43120' } }), ORIGIN, false,
    )).toBe(false)

    const wrongHost = request('GET', { headers: { host: 'localhost:43120' } })
    expect(isSameOriginEnterpriseRequest(wrongHost, ORIGIN, false)).toBe(false)
  })

  it('exports the three private route paths', () => {
    expect(DESKTOP_ENTERPRISE_IDENTITY_PATH).toBe('/api/desktop/enterprise/identity')
    expect(DESKTOP_ENTERPRISE_SIGNOUT_PATH).toBe('/api/desktop/enterprise/signout')
    expect(DESKTOP_ENTERPRISE_REAUTH_PATH).toBe('/api/desktop/enterprise/reauth')
  })
})

function res_allow(res: ReturnType<typeof response>): string | undefined {
  const call = res.setHeader.mock.calls.find((entry: readonly unknown[]) => entry[0] === 'allow')
  return call?.[1] as string | undefined
}
