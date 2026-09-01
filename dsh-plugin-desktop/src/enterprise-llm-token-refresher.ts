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
 *    gate-guided re-login takes over;
 * 5. weak binding (organization policy `desktopEvents=on`): a projection
 *    batch is submitted right before every issuance — pending session
 *    events, otherwise one synthesized heartbeat row — so the renewal's
 *    presence signal reaches the gateway first; a `409 heartbeat_stale`
 *    answer is answered with one immediate re-submit + one renewal retry,
 *    and only a second refusal hands over to re-login.
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
  /**
   * Weak binding: submit the renewal-time projection batch right before
   * each issuance (pending session events, otherwise one heartbeat row).
   * Optional — deployments without an organization gateway skip it.
   */
  readonly submitProjection?: () => Promise<boolean>
  /**
   * Invoked when a renewal stays `heartbeat_stale` even after an immediate
   * projection re-submit and one retry: the presence chain is broken past
   * self-healing, so re-login takes over (same gate-guided flow as 401).
   */
  readonly onSessionStale?: (cause: EnterpriseLlmTokenError) => void
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
    // Weak binding: the renewal batch goes out right before the issuance so
    // the gateway's liveness covers this renewal. A failed submit never
    // blocks the renewal itself — if liveness has aged out the gate answers
    // with its own stable error, and that path self-heals below.
    await this.deps.submitProjection?.().catch(() => false)
    try {
      const issued = await this.deps.issue(accessToken)
      return this.applyAndSchedule(issued)
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
        if (cause.code === 'heartbeat_stale') {
          // Liveness aged out (a silent stretch past the window): submit one
          // projection immediately and retry the renewal once — the OAuth
          // session carries on. Only a second refusal escalates to re-login;
          // this is never the blind backoff the transient path takes.
          this.deps.log?.warn?.('dsh-plugin-desktop: llm token renewal reported heartbeat_stale; submitting projection and retrying once')
          await this.deps.submitProjection?.().catch(() => false)
          try {
            const retried = await this.deps.issue(accessToken)
            return this.applyAndSchedule(retried)
          } catch (retryCause) {
            if (this.stopped) return false
            if (retryCause instanceof EnterpriseLlmTokenError) {
              if (retryCause.code === 'unauthorized') {
                this.deps.log?.error('dsh-plugin-desktop: the organization session was rejected during llm token issuance; guiding re-login')
                this.deps.onUnauthorized(retryCause)
                return false
              }
              if (retryCause.code === 'heartbeat_stale') {
                this.deps.log?.error('dsh-plugin-desktop: llm token renewal still reports heartbeat_stale after a projection resubmit; guiding re-login')
                this.deps.onSessionStale?.(retryCause)
                return false
              }
            }
            return this.backOffTransient(retryCause)
          }
        }
      }
      return this.backOffTransient(cause)
    }
  }

  /**
   * Shared success tail: apply the fresh token hot and schedule the next
   * renewal at half the remaining TTL. A stop() (sign-out teardown) that
   * landed while the issuance was in flight applies nothing — the write
   * points are already cleared then, and the fresh token must not resurrect
   * them for an account that just signed out.
   */
  private applyAndSchedule(issued: EnterpriseLlmToken): boolean {
    if (this.stopped) return false
    this.backoffExponent = 0
    this.deps.apply(issued)
    const now = this.deps.now()
    const halfLife = Math.max(Math.floor((issued.expiresAt - now) / 2), this.deps.minDelayMs ?? DEFAULT_MIN_DELAY_MS)
    this.schedule(halfLife)
    return true
  }

  /** Transient-failure path: exponential backoff, previous token keeps serving. */
  private backOffTransient(cause: unknown): boolean {
    const base = this.deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
    const max = this.deps.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS
    const delay = Math.min(base * 2 ** this.backoffExponent, max)
    this.backoffExponent += 1
    this.deps.log?.warn?.(`dsh-plugin-desktop: llm token issuance failed (${cause instanceof Error ? cause.message : String(cause)}); retrying in ${String(Math.round(delay / 1000))}s`)
    this.schedule(delay)
    return false
  }
}
