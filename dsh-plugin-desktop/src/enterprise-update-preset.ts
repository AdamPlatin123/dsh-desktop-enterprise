/** Self-hosted update source preset for enterprise deployments (15.1). */

/**
 * Build-time injection point. `tsdown.config.ts` defines this constant from
 * the `DSH_ENTERPRISE_UPDATE_URL` build environment (empty string when unset).
 * Test and source imports see the declared-undefined form, so every read goes
 * through the typeof guard.
 */
declare const __DSH_ENTERPRISE_UPDATE_URL__: string | undefined

/**
 * Runtime override channel for unpackaged development and tests; the build
 * preset stays primary. Empty by default: an enterprise deployment without a
 * preset update source performs no update checks at all — never the public
 * upstream endpoint.
 */
export const ENTERPRISE_UPDATE_URL_OVERRIDE = 'DSH_ENTERPRISE_UPDATE_URL'

/** Version metadata path served below the preset origin (documented contract). */
export const DESKTOP_UPDATE_VERSION_PATH = '/api/desktop/version'

/** Resolved update-source preset. `disabled` is the fail-closed default. */
export type EnterpriseUpdatePreset =
  | { readonly status: 'ok', readonly origin: string }
  | { readonly status: 'disabled', readonly reason?: string }

function buildTimeUpdateUrl(): string {
  return typeof __DSH_ENTERPRISE_UPDATE_URL__ === 'undefined' ? '' : __DSH_ENTERPRISE_UPDATE_URL__
}

/**
 * Resolve the self-hosted update source. The build-time define is primary;
 * the documented environment override exists so unpackaged development and
 * the headless test suite can point at a real source without a rebuild.
 * An unset, empty, or invalid preset resolves to `disabled` — a deployment
 * never falls back to the public upstream update endpoint.
 */
export function resolveEnterpriseUpdatePreset(
  env: Readonly<Record<string, string | undefined>> = process.env,
): EnterpriseUpdatePreset {
  const candidate = (env[ENTERPRISE_UPDATE_URL_OVERRIDE] ?? buildTimeUpdateUrl()).trim()
  if (candidate === '') return Object.freeze({ status: 'disabled' })
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return Object.freeze({ status: 'disabled', reason: 'the preset update source is not an absolute URL' })
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return Object.freeze({ status: 'disabled', reason: 'the preset update source must use http or https' })
  }
  if (url.username !== '' || url.password !== '') {
    return Object.freeze({ status: 'disabled', reason: 'the preset update source must not embed credentials' })
  }
  if (url.search !== '' || url.hash !== '') {
    return Object.freeze({ status: 'disabled', reason: 'the preset update source must not carry a query or fragment' })
  }
  if (url.pathname !== '' && url.pathname !== '/') {
    return Object.freeze({ status: 'disabled', reason: 'the preset update source must be an origin without a path' })
  }
  return Object.freeze({ status: 'ok', origin: url.origin })
}
