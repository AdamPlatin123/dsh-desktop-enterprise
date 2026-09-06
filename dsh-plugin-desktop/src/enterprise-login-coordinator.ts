/** Electron-free orchestration of one enterprise OAuth login attempt. */

import {
  EnterpriseOAuthError,
  buildEnterpriseAuthorizeUrl,
  createEnterprisePkcePair,
  createEnterpriseState,
  exchangeEnterpriseAuthorizationCode,
  parseEnterpriseIdTokenUsername,
  type EnterpriseTokenTransport,
} from './enterprise-oauth.ts'
import {
  EnterpriseLoopbackError,
  EnterpriseLoopbackListener,
  type EnterpriseLoopbackCallback,
} from './enterprise-loopback-callback.ts'
import { EnterpriseTokenStoreError, enterpriseTokenSchedule, type EnterpriseTokenSet } from './enterprise-token-store.ts'
import { enterpriseLoginCopy, type EnterpriseLoginView } from './enterprise-login-copy.ts'
import { fetchEnterpriseIdentity, fetchEnterpriseIdentityTransport, type EnterpriseIdentityTransport } from './enterprise-identity.ts'
import type { DesktopLocale } from './runtime.ts'

export type EnterpriseLoginAttemptOutcome =
  | 'authenticated'
  | 'denied'
  | 'timeout'
  | 'failed'
  | 'superseded'

export interface EnterpriseLoginUi {
  /** Push a view update; implementations forward it to the login window. */
  show(view: EnterpriseLoginView, context?: {
    readonly username?: string
    readonly errorMessage?: string
  }): void | Promise<void>
}

export interface EnterpriseLoginCoordinatorDeps {
  readonly locale: DesktopLocale
  readonly gatewayUrl: string
  readonly clientId: string
  readonly scope: string
  readonly timeoutMs: number
  readonly transport: EnterpriseTokenTransport
  readonly openBrowser: (url: string) => void | Promise<void>
  /** Injectable for tests; defaults to the real RFC 8252 loopback listener. */
  readonly startListener?: typeof EnterpriseLoopbackListener.start
  /** Injectable for tests; defaults to the shared fetch transport. Carries the userinfo fallback for the display username. */
  readonly identityTransport?: EnterpriseIdentityTransport
  readonly persistTokens: (tokens: EnterpriseTokenSet) => Promise<void>
  readonly now: () => number
  readonly log?: { readonly error: (message: string) => void }
}

/**
 * Drives the brief-13.2 client flow for one login window: loopback listener →
 * authorize URL → system browser → state check → token exchange → store.
 * The UI adapter receives every state transition so the window stays a dumb
 * view (brief 13.1 four states; no credential inputs anywhere).
 */
export class EnterpriseLoginCoordinator {
  private attemptCounter = 0
  private activeListener: EnterpriseLoopbackListener | undefined
  private inFlight: Promise<EnterpriseLoginAttemptOutcome> | undefined
  private currentAuthorizeUrl: string | undefined

  constructor(
    private readonly deps: EnterpriseLoginCoordinatorDeps,
    private readonly ui: EnterpriseLoginUi,
  ) {}

  /** The authorize URL of the current (or latest) attempt, for the copy-link escape hatch. */
  get authorizeUrl(): string | undefined {
    return this.currentAuthorizeUrl
  }

  /** Whether an attempt is currently driving the UI. */
  get busy(): boolean {
    return this.inFlight !== undefined
  }

  /**
   * Run one attempt to completion. Concurrent calls collapse into the running
   * attempt so double-clicks cannot fork the state machine.
   */
  attempt(): Promise<EnterpriseLoginAttemptOutcome> {
    if (this.inFlight !== undefined) return this.inFlight
    const run = this.runAttempt().finally(() => {
      if (this.inFlight === run) this.inFlight = undefined
    })
    this.inFlight = run
    return run
  }

  /** Stop the active listener (window close / gate teardown). */
  dispose(): void {
    this.attemptCounter += 1
    this.activeListener?.dispose()
    this.activeListener = undefined
  }

  private async runAttempt(): Promise<EnterpriseLoginAttemptOutcome> {
    const attemptId = ++this.attemptCounter
    const superseded = (): boolean => attemptId !== this.attemptCounter
    const startListener = this.deps.startListener ?? EnterpriseLoopbackListener.start

    let listener: EnterpriseLoopbackListener
    try {
      listener = await startListener({ timeoutMs: this.deps.timeoutMs })
    } catch (cause) {
      if (superseded()) return 'superseded'
      this.deps.log?.error(`dsh-plugin-desktop: loopback redirect listener failed: ${describe(cause)}`)
      void this.ui.show('error', { errorMessage: 'loopback listener unavailable' })
      return 'failed'
    }
    if (superseded()) {
      listener.dispose()
      return 'superseded'
    }
    this.activeListener?.dispose()
    this.activeListener = listener

    const pkce = createEnterprisePkcePair()
    const state = createEnterpriseState()
    const authorizeUrl = buildEnterpriseAuthorizeUrl({
      gatewayUrl: this.deps.gatewayUrl,
      clientId: this.deps.clientId,
      redirectUri: listener.redirectUri,
      state,
      codeChallenge: pkce.challenge,
      scope: this.deps.scope,
    })
    this.currentAuthorizeUrl = authorizeUrl
    await this.ui.show('waiting')

    try {
      await this.deps.openBrowser(authorizeUrl)
    } catch (cause) {
      if (superseded()) return 'superseded'
      listener.dispose()
      this.deps.log?.error(`dsh-plugin-desktop: system browser could not be opened: ${describe(cause)}`)
      void this.ui.show('error', { errorMessage: 'browser unavailable' })
      return 'failed'
    }

    let callback: EnterpriseLoopbackCallback
    try {
      callback = await listener.waitForCallback()
    } catch (cause) {
      if (superseded()) return 'superseded'
      if (cause instanceof EnterpriseLoopbackError && cause.code === 'timeout') {
        await this.ui.show('timeout')
        return 'timeout'
      }
      this.deps.log?.error(`dsh-plugin-desktop: loopback redirect wait failed: ${describe(cause)}`)
      await this.ui.show('error')
      return 'failed'
    }
    if (superseded()) return 'superseded'

    if (callback.kind === 'error') {
      if (callback.error === 'access_denied') {
        await this.ui.show('denied')
        return 'denied'
      }
      this.deps.log?.error(`dsh-plugin-desktop: authorization server returned ${callback.error}`)
      await this.ui.show('error', { errorMessage: callback.error })
      return 'failed'
    }
    if (callback.kind === 'malformed') {
      this.deps.log?.error('dsh-plugin-desktop: authorization redirect was malformed')
      await this.ui.show('error')
      return 'failed'
    }
    if (callback.state !== state) {
      // R14 red line: a state mismatch is never exchanged; it is dropped.
      this.deps.log?.error('dsh-plugin-desktop: authorization redirect state mismatch; dropping the response')
      await this.ui.show('error')
      return 'failed'
    }

    let tokens: EnterpriseTokenSet
    try {
      const response = await exchangeEnterpriseAuthorizationCode(this.deps.transport, {
        gatewayUrl: this.deps.gatewayUrl,
        clientId: this.deps.clientId,
        code: callback.code,
        codeVerifier: pkce.verifier,
        redirectUri: listener.redirectUri,
      })
      const now = this.deps.now()
      const schedule = enterpriseTokenSchedule(response.expiresInSeconds, now)
      // Display username: the id_token when it carries one, otherwise the
      // userinfo face. Best-effort either way — a fallback failure only
      // hides the welcome name, never the session.
      const username = parseEnterpriseIdTokenUsername(response.idToken)
        ?? await this.resolveUsername(response.accessToken)
      tokens = Object.freeze({
        accessToken: response.accessToken,
        refreshToken: response.refreshToken,
        scope: this.deps.scope,
        gatewayUrl: this.deps.gatewayUrl,
        clientId: this.deps.clientId,
        expiresAt: schedule.expiresAt,
        refreshAt: schedule.refreshAt,
        obtainedAt: now,
        ...(username === undefined ? {} : { username }),
      })
    } catch (cause) {
      if (superseded()) return 'superseded'
      const copy = enterpriseLoginCopy(this.deps.locale)
      const detail = cause instanceof EnterpriseOAuthError
        ? `${copy.errorTitle}: ${cause.code}`
        : copy.errorTitle
      this.deps.log?.error(`dsh-plugin-desktop: enterprise token exchange failed: ${describe(cause)}`)
      await this.ui.show('error', { errorMessage: detail })
      return 'failed'
    }

    try {
      await this.deps.persistTokens(tokens)
    } catch (cause) {
      if (superseded()) return 'superseded'
      this.deps.log?.error(`dsh-plugin-desktop: enterprise tokens could not be stored: ${describe(cause)}`)
      await this.ui.show(cause instanceof EnterpriseTokenStoreError ? 'storage-unavailable' : 'error')
      return 'failed'
    }

    await this.ui.show('success', tokens.username === undefined ? {} : { username: tokens.username })
    return 'authenticated'
  }

  /** Userinfo fallback for the display username when the id_token carries none. */
  private async resolveUsername(accessToken: string): Promise<string | undefined> {
    try {
      const identity = await fetchEnterpriseIdentity(
        this.deps.identityTransport ?? fetchEnterpriseIdentityTransport,
        { gatewayUrl: this.deps.gatewayUrl, accessToken },
      )
      return identity.username
    } catch (cause) {
      this.deps.log?.error(`dsh-plugin-desktop: userinfo username fallback failed: ${describe(cause)}`)
      return undefined
    }
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
