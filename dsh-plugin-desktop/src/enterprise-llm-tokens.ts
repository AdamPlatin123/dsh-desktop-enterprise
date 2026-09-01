/**
 * Client for the gateway's desktop LLM token issuance endpoint (D2).
 *
 * `POST /api/llm/tokens` with `Authorization: Bearer <OAuth access token>`
 * returns one short-lived代际 token for the enterprise model route
 * (`{ token, expiresAt, generation?, kind? }`). There is no refresh grant:
 * renewal is another POST, so the desktop chain re-issues with whatever OAuth
 * access token is current at half-life. Failures follow RFC 6750: a 401 means
 * the OAuth session itself is gone (the caller guides re-login), a 403 means
 * the session lacks the `llm` scope, a 409 with `heartbeat_stale` means the
 * organization's weak-binding policy wants a fresher projection report (the
 * chain retries later — the previously issued token stays valid), and
 * anything else is transient.
 */

/** Minimal HTTP transport; tests substitute a recording fake. */
export type EnterpriseLlmTokenTransport = (
  url: string,
  init: { readonly method: 'POST', readonly headers: Record<string, string> },
) => Promise<{ readonly status: number, readonly text: string }>

export type EnterpriseLlmTokenErrorCode =
  | 'unauthorized'
  | 'insufficient_scope'
  | 'heartbeat_stale'
  | 'unavailable'
  | 'http'
  | 'malformed'
  | 'network'

/** Stable, non-secret failure of one issuance attempt. */
export class EnterpriseLlmTokenError extends Error {
  readonly code: EnterpriseLlmTokenErrorCode
  /** RFC 6750 `error` code from the response body when one was present. */
  readonly serverCode: string | undefined

  constructor(code: EnterpriseLlmTokenErrorCode, message: string, options: {
    readonly serverCode?: string
    readonly cause?: unknown
  } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'EnterpriseLlmTokenError'
    this.code = code
    this.serverCode = options.serverCode
  }
}

/** One issued desktop egress token. `expiresAt` is epoch milliseconds. */
export interface EnterpriseLlmToken {
  readonly token: string
  readonly expiresAt: number
  readonly generation: number | undefined
}

export function enterpriseLlmTokenEndpoint(gatewayUrl: string): string {
  return new URL('/api/llm/tokens', gatewayUrl).href
}

function parseIssued(text: string): EnterpriseLlmToken {
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch (cause) {
    throw new EnterpriseLlmTokenError('malformed', 'llm token endpoint returned invalid JSON', { cause })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new EnterpriseLlmTokenError('malformed', 'llm token endpoint response must be a JSON object')
  }
  const object = value as Record<string, unknown>
  const token = object.token
  const expiresAt = object.expiresAt
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) {
    throw new EnterpriseLlmTokenError('malformed', 'llm token endpoint response has no usable token')
  }
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= 0) {
    throw new EnterpriseLlmTokenError('malformed', 'llm token endpoint response has no usable expiresAt')
  }
  const generation = object.generation
  return Object.freeze({
    token,
    expiresAt,
    generation: typeof generation === 'number' && Number.isSafeInteger(generation) ? generation : undefined,
  })
}

async function raiseForStatus(status: number, text: string): Promise<never> {
  let serverCode: string | undefined
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const candidate = (parsed as Record<string, unknown>).error
      if (typeof candidate === 'string') serverCode = candidate
    }
  } catch {
    // a non-JSON error body still maps onto the status below
  }
  if (status === 401) {
    throw new EnterpriseLlmTokenError('unauthorized', `llm token issuance was rejected (${serverCode ?? 'unauthorized'})`, {
      ...(serverCode === undefined ? {} : { serverCode }),
    })
  }
  if (status === 403) {
    throw new EnterpriseLlmTokenError('insufficient_scope', 'llm token issuance requires the llm scope', {
      ...(serverCode === undefined ? {} : { serverCode }),
    })
  }
  if (status === 409 && serverCode === 'heartbeat_stale') {
    // R39 weak binding: the gateway wants a fresher projection report before
    // renewing. Transient by design — the chain retries at its next half-life
    // tick and the previously issued token remains valid until then.
    throw new EnterpriseLlmTokenError('heartbeat_stale', 'llm token renewal waits for a fresher session report', {
      serverCode,
    })
  }
  if (status === 503) {
    throw new EnterpriseLlmTokenError('unavailable', 'llm token issuance is temporarily unavailable')
  }
  throw new EnterpriseLlmTokenError('http', `llm token endpoint returned HTTP ${String(status)}`, {
    ...(serverCode === undefined ? {} : { serverCode }),
  })
}

/** Issue one desktop LLM token with the current OAuth access token. */
export async function issueEnterpriseLlmToken(
  transport: EnterpriseLlmTokenTransport,
  options: {
    readonly gatewayUrl: string
    readonly accessToken: string
  },
): Promise<EnterpriseLlmToken> {
  let result: Awaited<ReturnType<EnterpriseLlmTokenTransport>>
  try {
    result = await transport(enterpriseLlmTokenEndpoint(options.gatewayUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${options.accessToken}` },
    })
  } catch (cause) {
    throw new EnterpriseLlmTokenError('network', 'llm token endpoint could not be reached', { cause })
  }
  if (result.status < 200 || result.status >= 300) await raiseForStatus(result.status, result.text)
  return parseIssued(result.text)
}

/** Default transport: exact POST with the bearer header and no body. */
export const fetchEnterpriseLlmTokenTransport: EnterpriseLlmTokenTransport = async (url, init) => {
  let response: Response
  try {
    response = await fetch(url, {
      method: init.method,
      headers: init.headers,
      cache: 'no-store',
    })
  } catch (cause) {
    throw new EnterpriseLlmTokenError('network', 'llm token endpoint could not be reached', { cause })
  }
  return { status: response.status, text: await response.text() }
}
