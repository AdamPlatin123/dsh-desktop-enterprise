/**
 * Strict loopback HTTP handlers for the private Desktop enterprise routes:
 * the settings-page identity projection (username + role) and the sign-out /
 * re-login entries. Same loopback + exact-origin discipline as the settings
 * API; the handlers themselves never touch tokens — the gate owns them.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { enterpriseRoleBadge, type EnterpriseIdentity } from './enterprise-identity.ts'

/** Read the current identity projection (undefined = no established session). */
export type DesktopEnterpriseIdentityReader = () => EnterpriseIdentity | undefined

/** The launcher-owned enterprise session surface, provided by main. */
export interface DesktopEnterpriseSurface {
  readonly identity: DesktopEnterpriseIdentityReader
  /**
   * Synchronous session-validity probe for the local HTTP fence (15.3).
   * True only while an established organization session is usable; the
   * re-login window, a failed refresh, or sign-out report false.
   */
  readonly sessionValid: () => boolean
  /** Revoke, clear, and reopen the login window. */
  readonly signout: () => Promise<void>
  /** Reopen the login window behind the session-expired notice. */
  readonly reauth: () => Promise<void>
  /**
   * Absolute admin console URL while the live identity projects an admin and
   * the gateway preset allows one; undefined otherwise (R22: a member has no
   * management surface in any form). Composed in main; the renderer only ever
   * asks for it to be opened.
   */
  readonly adminConsoleUrl: () => string | undefined
  /** Open the admin console in the system browser; rejections propagate (F1). */
  readonly openAdminConsole: (url: string) => Promise<void>
}

/**
 * Enterprise layer of the local HTTP fence (15.3): layer the revocable
 * organization session on top of the upstream browser-trust fence. Deployments
 * without an enterprise surface keep the upstream shape; a surface that does
 * not affirmatively report a valid session is rejected fail-closed, so an
 * expired desktop session also closes the local HTTP API even while the
 * upstream 30-day browser cookie would still authenticate it.
 *
 * Returns the rejection status, or undefined when the request is admitted.
 */
export function enterpriseSessionRejection(
  surface: DesktopEnterpriseSurface | undefined,
  allowWhenSessionInvalid: boolean,
): 401 | undefined {
  if (allowWhenSessionInvalid) return undefined
  if (surface === undefined) return undefined
  return surface.sessionValid() === true ? undefined : 401
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Launcher-owned enterprise session surface behind the private routes. */
    desktopEnterprise?: DesktopEnterpriseSurface
  }
}

/** Renderer-safe identity projection for the settings-page account area. */
export interface DesktopEnterpriseIdentityView {
  readonly username: string
  readonly role: string
}

export const DESKTOP_ENTERPRISE_IDENTITY_PATH = '/api/desktop/enterprise/identity'
export const DESKTOP_ENTERPRISE_SIGNOUT_PATH = '/api/desktop/enterprise/signout'
export const DESKTOP_ENTERPRISE_REAUTH_PATH = '/api/desktop/enterprise/reauth'
export const DESKTOP_ENTERPRISE_ADMIN_CONSOLE_PATH = '/api/desktop/enterprise/admin-console'

/**
 * R22 admin entry: exactly one fixed `/admin` deep link off the gateway
 * origin, composed only while the live identity projects an admin. There is
 * deliberately no probing and no second link — deployment topology is the
 * server-side admin console's concern.
 */
export function enterpriseAdminConsoleUrl(
  gatewayUrl: string | undefined,
  identity: EnterpriseIdentity | undefined,
): string | undefined {
  if (gatewayUrl === undefined) return undefined
  if (identity === undefined || enterpriseRoleBadge(identity.role) !== 'admin') return undefined
  return new URL('/admin', gatewayUrl).toString()
}

function finishJson(res: ServerResponse, statusCode: number, value: object, allow?: 'GET' | 'POST'): void {
  res.statusCode = statusCode
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('x-content-type-options', 'nosniff')
  if (allow !== undefined) res.setHeader('allow', allow)
  res.end(JSON.stringify(value))
}

function error(message: string): { readonly error: string } {
  return { error: message }
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  if (address === '::1' || address === '127.0.0.1') return true
  if (address.startsWith('::ffff:')) {
    const mapped = address.slice('::ffff:'.length)
    return mapped.startsWith('127.')
  }
  return false
}

function exactHeaderOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    const url = new URL(value)
    return url.origin === value ? value : undefined
  } catch {
    return undefined
  }
}

function referrerOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    return new URL(value).origin
  } catch {
    return undefined
  }
}

function expectedLoopbackOrigin(expectedOrigin: string): URL | undefined {
  try {
    const url = new URL(expectedOrigin)
    if (url.origin !== expectedOrigin || url.protocol !== 'http:'
      || url.username !== '' || url.password !== ''
      || !isLoopbackAddress(url.hostname === '[::1]' ? '::1' : url.hostname)) return undefined
    return url
  } catch {
    return undefined
  }
}

/** Same loopback + exact-origin rule as the settings API (mutating is strict). */
export function isSameOriginEnterpriseRequest(
  req: IncomingMessage,
  expectedOrigin: string,
  mutating: boolean,
): boolean {
  const expected = expectedLoopbackOrigin(expectedOrigin)
  if (expected === undefined || !isLoopbackAddress(req.socket.remoteAddress)) return false
  if (req.headers.host?.toLowerCase() !== expected.host.toLowerCase()) return false
  if (exactHeaderOrigin(req.headers.origin) === expected.origin) {
    return req.headers['sec-fetch-site'] === undefined || req.headers['sec-fetch-site'] === 'same-origin'
  }
  if (mutating) return false
  return req.headers['sec-fetch-site'] === 'same-origin'
    && referrerOrigin(req.headers.referer) === expected.origin
}

/** Serve the renderer-safe identity projection (404 while signed out). */
export async function handleDesktopEnterpriseIdentityRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  surface: DesktopEnterpriseSurface,
): Promise<void> {
  if (req.method !== 'GET') return finishJson(res, 405, error('method not allowed'), 'GET')
  if (!isSameOriginEnterpriseRequest(req, expectedOrigin, false)) {
    return finishJson(res, 403, error('forbidden'))
  }
  const identity = surface.identity()
  if (identity === undefined) return finishJson(res, 404, error('no enterprise session'))
  const view: DesktopEnterpriseIdentityView = { username: identity.username, role: identity.role }
  finishJson(res, 200, view)
}

/** Shared body of the two empty-body mutating enterprise actions. */
async function handleDesktopEnterpriseActionRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  action: () => Promise<void>,
): Promise<void> {
  if (req.method !== 'POST') return finishJson(res, 405, error('method not allowed'), 'POST')
  if (!isSameOriginEnterpriseRequest(req, expectedOrigin, true)) {
    return finishJson(res, 403, error('forbidden'))
  }
  const declaredLength = req.headers['content-length']
  if (declaredLength !== undefined && declaredLength !== '0') {
    return finishJson(res, 400, error('this endpoint takes no request body'))
  }
  try {
    await action()
  } catch {
    // The gate logs its own failures; the action always ends at a defined
    // surface (login window or unchanged session), so the renderer just
    // acknowledges the accepted request.
  }
  finishJson(res, 202, { accepted: true })
}

/** Revoke, clear, and return to the sign-in window ("switch account"). */
export function handleDesktopEnterpriseSignoutRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  surface: DesktopEnterpriseSurface,
): Promise<void> {
  return handleDesktopEnterpriseActionRequest(req, res, expectedOrigin, surface.signout)
}

/** Reopen the login window behind the session-expired notice. */
export function handleDesktopEnterpriseReauthRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  surface: DesktopEnterpriseSurface,
): Promise<void> {
  return handleDesktopEnterpriseActionRequest(req, res, expectedOrigin, surface.reauth)
}

/**
 * Open the organization admin console in the system browser. The URL is fixed
 * by main (gateway preset + /admin for an admin identity), so the renderer
 * cannot influence the target. Unlike the sign-out/re-login actions, a failed
 * browser open is NOT acknowledged: the rejection propagates as 502 so the
 * settings page surfaces the failure instead of a silent no-op (the F1 lesson
 * from the login gate).
 */
export async function handleDesktopEnterpriseAdminConsoleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  surface: DesktopEnterpriseSurface,
): Promise<void> {
  if (req.method !== 'POST') return finishJson(res, 405, error('method not allowed'), 'POST')
  if (!isSameOriginEnterpriseRequest(req, expectedOrigin, true)) {
    return finishJson(res, 403, error('forbidden'))
  }
  const declaredLength = req.headers['content-length']
  if (declaredLength !== undefined && declaredLength !== '0') {
    return finishJson(res, 400, error('this endpoint takes no request body'))
  }
  const url = surface.adminConsoleUrl()
  if (url === undefined) return finishJson(res, 404, error('no admin console for this identity'))
  try {
    await surface.openAdminConsole(url)
  } catch {
    return finishJson(res, 502, error('the system browser could not be opened'))
  }
  finishJson(res, 202, { accepted: true })
}
