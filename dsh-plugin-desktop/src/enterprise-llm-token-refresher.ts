/**
 * Independent half-life refresh loop for the desktop LLM token.
 *
 * Runs beside (not inside) the OAuth refresh loop: the代际 token has no
 * refresh grant, so renewal is simply another issuance with the OAuth access
 * token that is current at that moment. Failure rules (adapted from the
 * desktop runtime rule set R18):
 *
 * 1. at half the remaining TTL the token is silently re-issued;
 * 2. each issued token is applied hot (launch-environment override), so the
 *    next model request picks it up without a restart;
 * 3. transient failures (network, 5xx, malformed) back off exponentially and
 *    never disturb the user while the previous token is still valid;
 * 4. a 401 means the OAuth session itself is gone — the loop stops and the
 *    gate-guided re-login takes over.
 */

import { EnterpriseLlmTokenError, type EnterpriseLlmToken } from './enterprise-llm-tokens.ts'

export interface EnterpriseLlmTokenRefresherLog {
  readonly error: (message: string) => void
  readonly warn?: (message: string) => void
}

export interface EnterpriseLlmTokenRefresherDeps {
  readonly gatewayUrl: string
  /** Read the current OAuth access token; undefined = signed out. */
  readonly readAccessToken: () => Promise<string | undefined>
  /** Issue one代际 token against the gateway (injected for tests). */
  readonly issue: (accessToken: string) => Promise<EnterpriseLlmToken>
  /** Apply an issued token hot (launch-environment override + process.env). */
  readonly apply: (token: EnterpriseLlmToken) => void
  readonly now: () => number
  /** Floor for the half-life delay, guards boundary churn (default 1000ms). */
  readonly minDelayMs?: number
  /** Base delay for transient-failure backoff (default 30s). */
  readonly retryDelayMs?: number
  /** Ceiling for the transient-failure backoff (default 5min). */
  readonly maxRetryDelayMs?: number
  readonly log?: EnterpriseLlmTokenRefresherLog
  /** Invoked once on 401: the OAuth session is gone; re-login takes over. */
  readonly onUnauthorized: (cause: EnterpriseLlmTokenError) => void
}

const DEFAULT_MIN_DELAY_MS = 1_000
const DEFAULT_RETRY_DELAY_MS = 30_000
const DEFAULT_MAX_RETRY_DELAY_MS = 300_000

export class EnterpriseLlmTokenRefresher {
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private refreshing: Promise<boolean> | undefined
  private backoffExponent = 0

  constructor(private readonly deps: EnterpriseLlmTokenRefresherDeps) {}

  /** Begin the loop with an immediate issuance, then half-life scheduling. */
  start(): void {
    if (this.stopped) return
    void this.refreshNow()
  }

  /** Cancel the pending timer; the refresher cannot be restarted afterwards. */
  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  /**
   * Issue once, apply, and reschedule. Concurrent calls collapse into the
   * running attempt so the schedule and a forced refresh cannot double-issue.
   */
  refreshNow(): Promise<boolean> {
    if (this.refreshing !== undefined) return this.refreshing
    const attempt = this.performRefresh().finally(() => {
      if (this.refreshing === attempt) this.refreshing = undefined
    })
    this.refreshing = attempt
    return attempt
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return
    const delay = Math.max(delayMs, this.deps.minDelayMs ?? DEFAULT_MIN_DELAY_MS)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.refreshNow()
    }, delay)
    this.timer.unref?.()
  }

  private async performRefresh(): Promise<boolean> {
    if (this.stopped) return false
    const accessToken = await this.deps.readAccessToken().catch(() => undefined)
    if (this.stopped) return false
    if (accessToken === undefined || accessToken.length === 0) return false
    let issued: EnterpriseLlmToken
    try {
      issued = await this.deps.issue(accessToken)
    } catch (cause) {
      if (this.stopped) return false
      if (cause instanceof EnterpriseLlmTokenError) {
        if (cause.code === 'unauthorized') {
          this.deps.log?.error('dsh-plugin-desktop: the organization session was rejected during llm token issuance; guiding re-login')
          this.deps.onUnauthorized(cause)
          return false
        }
        if (cause.code === 'insufficient_scope') {
          this.deps.log?.error('dsh-plugin-desktop: llm token issuance lacks the llm scope; contact the organization administrator')
          return false
        }
      }
      // Transient: back off and try again; the previous token keeps serving
      // until it expires, so the user is never disturbed for a blip.
      const base = this.deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
      const max = this.deps.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS
      const delay = Math.min(base * 2 ** this.backoffExponent, max)
      this.backoffExponent += 1
      this.deps.log?.warn?.(`dsh-plugin-desktop: llm token issuance failed (${cause instanceof Error ? cause.message : String(cause)}); retrying in ${String(Math.round(delay / 1000))}s`)
      this.schedule(delay)
      return false
    }
    // A stop() (sign-out teardown) may land while the issuance was in flight;
    // the write points are already cleared then, so the fresh token must not
    // resurrect them for an account that just signed out.
    if (this.stopped) return false
    this.backoffExponent = 0
    this.deps.apply(issued)
    const now = this.deps.now()
    const halfLife = Math.max(Math.floor((issued.expiresAt - now) / 2), this.deps.minDelayMs ?? DEFAULT_MIN_DELAY_MS)
    this.schedule(halfLife)
    return true
  }
}
