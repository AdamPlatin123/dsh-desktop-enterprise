/**
 * Enterprise identity projection: the signed-in user's display name and role,
 * read from the gateway's OIDC userinfo endpoint. The desktop client already
 * requested the `openid` scope, and the role travels with every read, so each
 * OAuth refresh that re-reads identity reflects role changes made on the
 * server while the session lived on.
 */

/** Minimal HTTP transport; tests substitute a recording fake. */
export type EnterpriseIdentityTransport = (
  url: string,
  init: { readonly method: 'GET', readonly headers: Record<string, string> },
) => Promise<{ readonly status: number, readonly text: string }>

export type EnterpriseIdentityErrorCode = 'unauthorized' | 'http' | 'malformed' | 'network'

/** Stable, non-secret failure of one identity read. */
export class EnterpriseIdentityError extends Error {
  readonly code: EnterpriseIdentityErrorCode

  constructor(code: EnterpriseIdentityErrorCode, message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'EnterpriseIdentityError'
    this.code = code
  }
}

/** Display identity of one signed-in organization user. */
export interface EnterpriseIdentity {
  readonly username: string
  readonly role: string
}

export function enterpriseUserinfoEndpoint(gatewayUrl: string): string {
  return new URL('/api/oauth/userinfo', gatewayUrl).href
}

/** Roles the gateway issues today; unknown values render as-is. */
export type EnterpriseRoleBadge = 'admin' | 'member'

/** Map a server role onto a bounded badge; anything else falls back to member. */
export function enterpriseRoleBadge(role: string): EnterpriseRoleBadge {
  return role === 'admin' ? 'admin' : 'member'
}

function parseIdentity(text: string): EnterpriseIdentity {
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch (cause) {
    throw new EnterpriseIdentityError('malformed', 'userinfo endpoint returned invalid JSON', { cause })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new EnterpriseIdentityError('malformed', 'userinfo endpoint response must be a JSON object')
  }
  const object = value as Record<string, unknown>
  const username = object.username
  const role = object.role
  if (typeof username !== 'string' || username.length === 0 || username.length > 256) {
    throw new EnterpriseIdentityError('malformed', 'userinfo endpoint response has no usable username')
  }
  if (typeof role !== 'string' || role.length === 0 || role.length > 64) {
    throw new EnterpriseIdentityError('malformed', 'userinfo endpoint response has no usable role')
  }
  return Object.freeze({ username, role })
}

/** Read the display identity behind one OAuth access token. */
export async function fetchEnterpriseIdentity(
  transport: EnterpriseIdentityTransport,
  options: {
    readonly gatewayUrl: string
    readonly accessToken: string
  },
): Promise<EnterpriseIdentity> {
  let result: Awaited<ReturnType<EnterpriseIdentityTransport>>
  try {
    result = await transport(enterpriseUserinfoEndpoint(options.gatewayUrl), {
      method: 'GET',
      headers: { authorization: `Bearer ${options.accessToken}` },
    })
  } catch (cause) {
    throw new EnterpriseIdentityError('network', 'userinfo endpoint could not be reached', { cause })
  }
  if (result.status === 401) {
    throw new EnterpriseIdentityError('unauthorized', 'userinfo endpoint rejected the session')
  }
  if (result.status < 200 || result.status >= 300) {
    throw new EnterpriseIdentityError('http', `userinfo endpoint returned HTTP ${String(result.status)}`)
  }
  return parseIdentity(result.text)
}

/** Default transport: exact GET with the bearer header. */
export const fetchEnterpriseIdentityTransport: EnterpriseIdentityTransport = async (url, init) => {
  let response: Response
  try {
    response = await fetch(url, { method: init.method, headers: init.headers, cache: 'no-store' })
  } catch (cause) {
    throw new EnterpriseIdentityError('network', 'userinfo endpoint could not be reached', { cause })
  }
  return { status: response.status, text: await response.text() }
}
