/** Enterprise OAuth client core: PKCE S256, authorize URL, token endpoint forms. */

import { createHash, randomBytes } from 'node:crypto'
import { ENTERPRISE_OAUTH_SCOPE } from './enterprise-gateway-preset.ts'

/** RFC 6749 §5.2 token-endpoint error codes the client maps onto UI states. */
export type EnterpriseOAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'invalid_scope'
  | 'server_error'
  | 'malformed_response'
  | 'network'

/** Stable, non-secret failure surfaced by the enterprise OAuth boundary. */
export class EnterpriseOAuthError extends Error {
  readonly code: EnterpriseOAuthErrorCode

  constructor(code: EnterpriseOAuthErrorCode, message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'EnterpriseOAuthError'
    this.code = code
  }
}

/** PKCE pair per RFC 7636 §4.1: high-entropy verifier plus its S256 challenge. */
export interface EnterprisePkcePair {
  readonly verifier: string
  readonly challenge: string
}

/** Successful RFC 6749 §5.1 token response (subset the client persists). */
export interface EnterpriseTokenResponse {
  readonly accessToken: string
  readonly refreshToken: string
  /** Access-token lifetime in seconds (server `expires_in`). */
  readonly expiresInSeconds: number
  /** ES256 id_token when issued; parsed only for display, never trusted. */
  readonly idToken?: string
}

/** Minimal token-endpoint transport; tests substitute a recording fake. */
export type EnterpriseTokenTransport = (
  endpointUrl: string,
  form: URLSearchParams,
) => Promise<{ readonly status: number, readonly text: string }>

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url')
}

/** Generate a fresh PKCE verifier (64 base64url chars) with its S256 challenge. */
export function createEnterprisePkcePair(): EnterprisePkcePair {
  const verifier = base64url(randomBytes(48))
  const challenge = base64url(createHash('sha256').update(verifier, 'utf8').digest())
  return Object.freeze({ verifier, challenge })
}

/** Generate a fresh unpredictable `state` value for one authorization attempt. */
export function createEnterpriseState(): string {
  return base64url(randomBytes(32))
}

/**
 * Build the authorization-request URL for `GET /api/oauth/authorize`. The
 * loopback `redirectUri` matches the server's registered
 * `http://127.0.0.1:*` pattern (RFC 8252 §7.3).
 */
export function buildEnterpriseAuthorizeUrl(options: {
  readonly gatewayUrl: string
  readonly clientId: string
  readonly redirectUri: string
  readonly state: string
  readonly codeChallenge: string
  readonly scope?: string
}): string {
  const url = new URL('/api/oauth/authorize', options.gatewayUrl)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', options.clientId)
  url.searchParams.set('redirect_uri', options.redirectUri)
  url.searchParams.set('scope', options.scope ?? ENTERPRISE_OAUTH_SCOPE)
  url.searchParams.set('state', options.state)
  url.searchParams.set('code_challenge', options.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  return url.href
}

function parseTokenResponse(text: string): EnterpriseTokenResponse {
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch (cause) {
    throw new EnterpriseOAuthError('malformed_response', 'token endpoint returned invalid JSON', { cause })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new EnterpriseOAuthError('malformed_response', 'token endpoint response must be a JSON object')
  }
  const object = value as Record<string, unknown>
  const accessToken = object.access_token
  const refreshToken = object.refresh_token
  const expiresIn = object.expires_in
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new EnterpriseOAuthError('malformed_response', 'token endpoint response has no access_token')
  }
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    throw new EnterpriseOAuthError('malformed_response', 'token endpoint response has no refresh_token')
  }
  if (typeof expiresIn !== 'number' || !Number.isSafeInteger(expiresIn) || expiresIn <= 0) {
    throw new EnterpriseOAuthError('malformed_response', 'token endpoint response has no usable expires_in')
  }
  const idToken = object.id_token
  return Object.freeze({
    accessToken,
    refreshToken,
    expiresInSeconds: expiresIn,
    ...(typeof idToken === 'string' && idToken.length > 0 ? { idToken } : {}),
  })
}

function tokenEndpoint(gatewayUrl: string): string {
  return new URL('/api/oauth/token', gatewayUrl).href
}

function assertHttpOk(status: number, text: string): void {
  if (status >= 200 && status < 300) return
  let error: string | undefined
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const candidate = (parsed as Record<string, unknown>).error
      if (typeof candidate === 'string') error = candidate
    }
  } catch {
    // fall through to the generic mapping
  }
  if (error === 'invalid_request' || error === 'invalid_client' || error === 'invalid_grant'
    || error === 'unauthorized_client' || error === 'unsupported_grant_type' || error === 'invalid_scope'
    || error === 'server_error') {
    throw new EnterpriseOAuthError(error, `token endpoint rejected the request: ${error}`)
  }
  throw new EnterpriseOAuthError(
    status >= 500 ? 'server_error' : 'invalid_request',
    `token endpoint returned HTTP ${String(status)}`,
  )
}

/** Default transport: exact form-urlencoded POST with no credential leakage. */
export const fetchEnterpriseTokenTransport: EnterpriseTokenTransport = async (endpointUrl, form) => {
  let response: Response
  try {
    response = await fetch(endpointUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      cache: 'no-store',
    })
  } catch (cause) {
    throw new EnterpriseOAuthError('network', 'token endpoint could not be reached', { cause })
  }
  return { status: response.status, text: await response.text() }
}

/** Exchange one authorization code for the initial token set (public client, PKCE only). */
export async function exchangeEnterpriseAuthorizationCode(
  transport: EnterpriseTokenTransport,
  options: {
    readonly gatewayUrl: string
    readonly clientId: string
    readonly code: string
    readonly codeVerifier: string
  },
): Promise<EnterpriseTokenResponse> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: options.code,
    code_verifier: options.codeVerifier,
    client_id: options.clientId,
  })
  let result: Awaited<ReturnType<EnterpriseTokenTransport>>
  try {
    result = await transport(tokenEndpoint(options.gatewayUrl), form)
  } catch (cause) {
    if (cause instanceof EnterpriseOAuthError) throw cause
    throw new EnterpriseOAuthError('network', 'token endpoint transport failed', { cause })
  }
  assertHttpOk(result.status, result.text)
  return parseTokenResponse(result.text)
}

/** Rotate a token set with `grant_type=refresh_token` (public client). */
export async function refreshEnterpriseTokens(
  transport: EnterpriseTokenTransport,
  options: {
    readonly gatewayUrl: string
    readonly clientId: string
    readonly refreshToken: string
  },
): Promise<EnterpriseTokenResponse> {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: options.refreshToken,
    client_id: options.clientId,
  })
  let result: Awaited<ReturnType<EnterpriseTokenTransport>>
  try {
    result = await transport(tokenEndpoint(options.gatewayUrl), form)
  } catch (cause) {
    if (cause instanceof EnterpriseOAuthError) throw cause
    throw new EnterpriseOAuthError('network', 'token endpoint transport failed', { cause })
  }
  assertHttpOk(result.status, result.text)
  return parseTokenResponse(result.text)
}

/**
 * Extract the display username from an id_token payload. The token was
 * obtained directly from the gateway over this client's own token exchange,
 * so base64 decoding without signature verification is display-only and
 * never an authorization decision.
 */
export function parseEnterpriseIdTokenUsername(idToken: string | undefined): string | undefined {
  if (idToken === undefined) return undefined
  const parts = idToken.split('.')
  const payload = parts[1]
  if (parts.length !== 3 || payload === undefined) return undefined
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const username = (parsed as Record<string, unknown>).username
    if (typeof username !== 'string' || username.length === 0 || username.length > 256) return undefined
    return username
  } catch {
    return undefined
  }
}

export const enterpriseOAuthConstants = Object.freeze({
  scope: ENTERPRISE_OAUTH_SCOPE,
  authorizePath: '/api/oauth/authorize',
  tokenPath: '/api/oauth/token',
  codeChallengeMethod: 'S256',
})
