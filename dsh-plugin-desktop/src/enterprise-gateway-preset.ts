/** Organization gateway preset for the enterprise login gate (R15: read-only, no manual input). */

/**
 * Build-time injection points. `tsdown.config.ts` defines both constants from
 * the `DSH_ENTERPRISE_GATEWAY_URL` / `DSH_ENTERPRISE_OAUTH_CLIENT_ID` build
 * environment (empty string when unset). Test and source imports see the
 * declared-undefined form, so every read goes through the typeof guard.
 */
declare const __DSH_ENTERPRISE_GATEWAY_URL__: string | undefined
declare const __DSH_ENTERPRISE_OAUTH_CLIENT_ID__: string | undefined

const BIN_NAME = 'dsh-plugin-desktop'

/** The OAuth scope the enterprise client requests: identity, session, and model egress. */
export const ENTERPRISE_OAUTH_SCOPE = 'openid session llm'

/** Runtime override channels for unpackaged development and tests; presets stay primary. */
export const ENTERPRISE_GATEWAY_URL_OVERRIDE = 'DSH_ENTERPRISE_GATEWAY_URL'
export const ENTERPRISE_OAUTH_CLIENT_ID_OVERRIDE = 'DSH_ENTERPRISE_OAUTH_CLIENT_ID'

/**
 * Stable outcome of preset resolution. `missing` and `invalid` both route the
 * login gate to the explicit misconfiguration page — there is deliberately no
 * input field that could turn a mispreset deployment into a phishing surface.
 */
export type EnterpriseGatewayPreset =
  | { readonly status: 'ok', readonly gatewayUrl: string, readonly clientId: string }
  | { readonly status: 'missing' }
  | { readonly status: 'invalid', readonly detail: string }

function buildTimeGatewayUrl(): string {
  return typeof __DSH_ENTERPRISE_GATEWAY_URL__ === 'undefined' ? '' : __DSH_ENTERPRISE_GATEWAY_URL__
}

function buildTimeClientId(): string {
  return typeof __DSH_ENTERPRISE_OAUTH_CLIENT_ID__ === 'undefined' ? '' : __DSH_ENTERPRISE_OAUTH_CLIENT_ID__
}

/** Validate one candidate gateway origin and canonicalize it for comparisons. */
export function validateEnterpriseGatewayUrl(candidate: string): string {
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new TypeError(`${BIN_NAME}: enterprise gateway URL must be an absolute http(s) URL`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError(`${BIN_NAME}: enterprise gateway URL must use http or https`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError(`${BIN_NAME}: enterprise gateway URL must not embed credentials`)
  }
  if (url.search !== '' || url.hash !== '') {
    throw new TypeError(`${BIN_NAME}: enterprise gateway URL must not carry a query or fragment`)
  }
  if (url.pathname !== '' && url.pathname !== '/') {
    throw new TypeError(`${BIN_NAME}: enterprise gateway URL must be an origin without a path`)
  }
  return url.origin
}

/**
 * Resolve the organization gateway preset. Build-time defines are primary;
 * the documented environment overrides exist so unpackaged development and
 * the headless test suite can point at a real gateway without a rebuild.
 */
export function resolveEnterpriseGatewayPreset(
  env: Readonly<Record<string, string | undefined>> = process.env,
): EnterpriseGatewayPreset {
  const rawGatewayUrl = env[ENTERPRISE_GATEWAY_URL_OVERRIDE] ?? buildTimeGatewayUrl()
  const clientId = (env[ENTERPRISE_OAUTH_CLIENT_ID_OVERRIDE] ?? buildTimeClientId()).trim()
  const gatewayUrl = rawGatewayUrl.trim()
  if (gatewayUrl === '' && clientId === '') return Object.freeze({ status: 'missing' })
  if (gatewayUrl === '') {
    return Object.freeze({ status: 'invalid', detail: 'gateway URL is missing while an OAuth client id is preset' })
  }
  if (clientId === '') {
    return Object.freeze({ status: 'invalid', detail: 'OAuth client id is missing while a gateway URL is preset' })
  }
  try {
    return Object.freeze({
      status: 'ok',
      gatewayUrl: validateEnterpriseGatewayUrl(gatewayUrl),
      clientId,
    })
  } catch (cause) {
    return Object.freeze({
      status: 'invalid',
      detail: cause instanceof Error ? cause.message : String(cause),
    })
  }
}
