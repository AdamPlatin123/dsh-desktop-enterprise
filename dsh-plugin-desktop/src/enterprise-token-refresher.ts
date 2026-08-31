/** Background refresh loop: rotate the token set at half its remaining lifetime. */

import { EnterpriseOAuthError, refreshEnterpriseTokens, type EnterpriseTokenResponse, type EnterpriseTokenTransport } from './enterprise-oauth.ts'
import type { EnterpriseTokenSet } from './enterprise-token-store.ts'

export interface EnterpriseTokenRefresherLog {
  readonly error: (message: string) => void
}

export interface EnterpriseTokenRefresherDeps {
  readonly gatewayUrl: string
  readonly clientId: string
  readonly transport: EnterpriseTokenTransport
  /** Read the currently stored token set (undefined = signed out). */
  readonly read: () => Promise<EnterpriseTokenSet | undefined>
  /** Persist a rotated token set. */
  readonly save: (tokens: EnterpriseTokenSet) => Promise<void>
  readonly now: () => number
  /** Minimum scheduled delay; guards the half-life boundary against churn. */
  readonly minDelayMs?: number
  readonly log?: EnterpriseTokenRefresherLog
  /** Invoked when the refresh grant fails; the gate reopens re-login. */
  readonly onRefreshFailed: (cause: unknown) => void
  /** Invoked after each successful rotation (T14 hook point). */
  readonly onRefreshed?: (tokens: EnterpriseTokenSet) => void
}

/**
 * Owns exactly one pending refresh timer. `start` schedules from the stored
 * `refreshAt` (half-life); `refreshNow` forces an immediate rotation and is
 * also the timer body. Failures never clear stored tokens — the session
 * stays until the user completes a fresh login (brief 13.2).
 */
export class EnterpriseTokenRefresher {
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private refreshing: Promise<boolean> | undefined

  constructor(private readonly deps: EnterpriseTokenRefresherDeps) {}

  /** Schedule the next half-life rotation. Safe to call again after refreshes. */
  start(): void {
    if (this.stopped) return
    void this.scheduleFromStore()
  }

  /** Cancel the pending timer; the refresher cannot be restarted afterwards. */
  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Rotate immediately; returns whether the store now holds a fresh set. */
  refreshNow(): Promise<boolean> {
    if (this.refreshing !== undefined) return this.refreshing
    const attempt = this.performRefresh().finally(() => {
      if (this.refreshing === attempt) this.refreshing = undefined
    })
    this.refreshing = attempt
    return attempt
  }

  private async scheduleFromStore(): Promise<void> {
    if (this.stopped) return
    const tokens = await this.deps.read().catch(() => undefined)
    if (this.stopped) return
    if (tokens === undefined || tokens.gatewayUrl !== this.deps.gatewayUrl) return
    const now = this.deps.now()
    const delay = Math.max(tokens.refreshAt - now, this.deps.minDelayMs ?? 1000)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.refreshNow()
    }, delay)
    this.timer.unref?.()
  }

  private async performRefresh(): Promise<boolean> {
    if (this.stopped) return false
    const tokens = await this.deps.read().catch((cause: unknown) => {
      this.deps.log?.error(`dsh-plugin-desktop: enterprise token store became unreadable before refresh: ${describe(cause)}`)
      return undefined
    })
    if (this.stopped) return false
    if (tokens === undefined || tokens.gatewayUrl !== this.deps.gatewayUrl) return false
    let response: EnterpriseTokenResponse
    try {
      response = await refreshEnterpriseTokens(this.deps.transport, {
        gatewayUrl: this.deps.gatewayUrl,
        clientId: this.deps.clientId,
        refreshToken: tokens.refreshToken,
      })
    } catch (cause) {
      // invalid_grant means the family was revoked server-side; either way the
      // stored session is preserved and re-login is guided (brief 13.2).
      const code = cause instanceof EnterpriseOAuthError ? cause.code : 'unknown'
      this.deps.log?.error(`dsh-plugin-desktop: enterprise token refresh failed (${code}); guiding re-login`)
      this.deps.onRefreshFailed(cause)
      return false
    }
    const now = this.deps.now()
    const rotated = Object.freeze({
      ...tokens,
      accessToken: response.accessToken,
      refreshToken: response.refreshToken,
      expiresAt: now + response.expiresInSeconds * 1000,
      refreshAt: now + Math.floor(response.expiresInSeconds * 500),
      obtainedAt: now,
    })
    try {
      await this.deps.save(rotated)
    } catch (cause) {
      this.deps.log?.error(`dsh-plugin-desktop: rotated enterprise tokens could not be stored: ${describe(cause)}`)
      this.deps.onRefreshFailed(cause)
      return false
    }
    this.deps.onRefreshed?.(rotated)
    void this.scheduleFromStore()
    return true
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
