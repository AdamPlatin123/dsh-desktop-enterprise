/** Pre-Host enterprise login gate: session check, four-state window, refresh loop. */

import type { DesktopLocale } from './runtime.ts'
import { resolveEnterpriseGatewayPreset, ENTERPRISE_OAUTH_SCOPE } from './enterprise-gateway-preset.ts'
import {
  fetchEnterpriseTokenTransport,
  refreshEnterpriseTokens,
  revokeEnterpriseToken,
  type EnterpriseTokenTransport,
} from './enterprise-oauth.ts'
import { ENTERPRISE_LOGIN_TIMEOUT_MS } from './enterprise-loopback-callback.ts'
import { EnterpriseTokenRefresher } from './enterprise-token-refresher.ts'
import {
  EnterpriseTokenStoreError,
  clearEnterpriseTokens,
  enterpriseTokenValidity,
  readEnterpriseTokens,
  saveEnterpriseTokens,
  type EnterpriseTokenSet,
} from './enterprise-token-store.ts'
import {
  fetchEnterpriseIdentityTransport,
  fetchEnterpriseIdentity,
  type EnterpriseIdentity,
  type EnterpriseIdentityTransport,
} from './enterprise-identity.ts'
import type { EnterpriseLlmTokenTransport } from './enterprise-llm-tokens.ts'
import type { DesktopLanHttpsPrivateKeyProtector } from './lan-https-certificate.ts'
import type { EnterpriseLoginView } from './enterprise-login-copy.ts'
import { EnterpriseLoginCoordinator, type EnterpriseLoginUi } from './enterprise-login-coordinator.ts'
import { renderEnterpriseMachinePatch, writeEnterpriseMachinePatch, type EnterpriseMachinePatchOutcome } from './enterprise-cordis-patch.ts'
import type {
  DesktopEnterpriseLoginResult,
  DesktopEnterpriseLoginWindowInput,
  DesktopEnterpriseLoginWindowOptions,
} from './enterprise-login-window.ts'

const BIN_NAME = 'dsh-plugin-desktop'

/** Structural window surface the gate drives; the Electron window implements it. */
export interface EnterpriseLoginWindowLike {
  show(): void
  showView(input: DesktopEnterpriseLoginWindowInput): void
  run(): Promise<DesktopEnterpriseLoginResult>
}

export interface DesktopEnterpriseGateDeps {
  readonly userDataDir: string
  readonly homeDir: string
  readonly locale: DesktopLocale
  readonly platform: NodeJS.Platform
  readonly protector: DesktopLanHttpsPrivateKeyProtector
  /** Open the authorize URL in the system browser (shell.openExternal in main). */
  readonly openExternal: (url: string) => void | Promise<void>
  /** Clipboard escape hatch (clipboard.writeText in main). */
  readonly copyToClipboard: (text: string) => void
  readonly logger: { readonly error: (message: string) => void }
  /** Window factory injectable for tests; the real login window in main. */
  readonly createWindow?: (options: DesktopEnterpriseLoginWindowOptions) => EnterpriseLoginWindowLike
  readonly transport?: EnterpriseTokenTransport
  readonly now?: () => number
  /** Preset env override hook for tests; defaults to process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly timeoutMs?: number
  readonly patchWriter?: typeof writeEnterpriseMachinePatch
  /** LLM代际-token issuance transport; tests substitute a recording fake. */
  readonly llmTokenTransport?: EnterpriseLlmTokenTransport
  /** Userinfo transport for the identity projection; tests substitute a fake. */
  readonly identityTransport?: EnterpriseIdentityTransport
  /**
   * Session established (fresh login, silent refresh at gate entry, or
   * re-login): the launcher issues the first LLM token and starts its chain
   * here, before Host boot. Failures must never fail the login itself.
   */
  readonly onSessionEstablished?: () => void | Promise<void>
  /** Session ended by explicit sign-out: clear the LLM env and stop its chain. */
  readonly onSessionEnded?: () => void
}

export type DesktopEnterpriseGateRunResult =
  | { readonly outcome: 'authenticated' }
  | { readonly outcome: 'quit' }

/**
 * The pre-Host enterprise gate (brief 13.1/13.2). `run()` blocks Host boot
 * behind the login window when no usable session exists; `startMaintenance()`
 * begins the half-life refresh loop once a session is established. The
 * single-instance behavior (R19) is owned by main.ts's launcher lock, which
 * reveals this gate's window on second-instance activation.
 */
export class DesktopEnterpriseGate {
  private readonly transport: EnterpriseTokenTransport
  private readonly now: () => number
  private readonly timeoutMs: number
  private window: EnterpriseLoginWindowLike | undefined
  private coordinator: EnterpriseLoginCoordinator | undefined
  private refresher: EnterpriseTokenRefresher | undefined
  private serverOrigin = ''
  private presetUrl: string | undefined
  private presetClientId: string | undefined
  private reauthing = false
  private identity: EnterpriseIdentity | undefined
  /** True only while an established session is usable (15.3 fence probe). */
  private sessionEstablished = false

  constructor(private readonly deps: DesktopEnterpriseGateDeps) {
    this.transport = deps.transport ?? fetchEnterpriseTokenTransport
    this.now = deps.now ?? (() => Date.now())
    this.timeoutMs = deps.timeoutMs ?? ENTERPRISE_LOGIN_TIMEOUT_MS
  }

  /** Identity projection for the settings-page account area; undefined until first read. */
  getIdentity(): EnterpriseIdentity | undefined {
    return this.identity
  }

  /**
   * Synchronous validity of the established organization session. False until
   * the first successful sign-in and again whenever the login window reopens
   * (expired refresh, explicit re-login, or sign-out); the local HTTP fence
   * consumes this to reject private routes while no usable session exists.
   */
  isSessionValid(): boolean {
    return this.sessionEstablished
  }

  /** Surface for main's activation/second-instance reveal chain. */
  showSurface(): boolean {
    if (this.window === undefined) return false
    this.window.show()
    return true
  }

  /**
   * Install the machine patch (13.3) under the fail-closed rule (14.1/O4):
   * the login may only proceed when the enterprise model route is locked.
   * A write failure returns 'patch-failed' and an admin-authored file returns
   * 'patch-admin-kept'; the caller blocks sign-in behind the matching view.
   */
  private async installMachinePatch(gatewayUrl: string): Promise<EnterpriseMachinePatchOutcome | 'patch-failed'> {
    const document = renderEnterpriseMachinePatch({ gatewayUrl })
    const write = this.deps.patchWriter ?? writeEnterpriseMachinePatch
    try {
      const outcome = await write(this.deps.homeDir, document)
      if (outcome.status === 'admin-file-kept') {
        this.deps.logger.error(`${BIN_NAME}: an admin-authored cordis.patch.yml exists in the DSH home; the enterprise model route was not applied and sign-in stays blocked`)
      }
      return outcome
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      this.deps.logger.error(`${BIN_NAME}: machine patch could not be written; sign-in stays blocked: ${detail}`)
      return 'patch-failed'
    }
  }

  private async defaultWindowFactory(): Promise<(options: DesktopEnterpriseLoginWindowOptions) => EnterpriseLoginWindowLike> {
    // Dynamic import keeps every gate-level test Electron-free.
    const { DesktopEnterpriseLoginWindow } = await import('./enterprise-login-window.ts')
    return options => new DesktopEnterpriseLoginWindow(options)
  }

  private async createGateWindow(input: DesktopEnterpriseLoginWindowInput): Promise<EnterpriseLoginWindowLike> {
    const create = this.deps.createWindow ?? await this.defaultWindowFactory()
    const window = create({
      locale: this.deps.locale,
      platform: this.deps.platform,
      input,
      onAction: action => { this.handleWindowAction(action) },
    })
    this.window = window
    return window
  }

  private handleWindowAction(action: 'open-browser' | 'copy-link' | 'retry' | 'back'): void {
    if (action === 'open-browser' || action === 'retry') {
      void this.coordinator?.attempt()
      return
    }
    if (action === 'copy-link') {
      const url = this.coordinator?.authorizeUrl
      if (url !== undefined) this.deps.copyToClipboard(url)
      return
    }
    // 'back': return to the initial state (R14: denied returns to initial).
    this.window?.showView(this.windowInput('initial'))
  }

  private timeoutMinutes(): number {
    return Math.max(1, Math.round(this.timeoutMs / 60000))
  }

  private windowInput(view: EnterpriseLoginView, extra?: {
    readonly username?: string
    readonly errorMessage?: string
    readonly notice?: 'session-expired'
  }): DesktopEnterpriseLoginWindowInput {
    return {
      view,
      serverOrigin: this.serverOrigin,
      timeoutMinutes: this.timeoutMinutes(),
      ...(extra?.username === undefined ? {} : { username: extra.username }),
      ...(extra?.errorMessage === undefined ? {} : { errorMessage: extra.errorMessage }),
      ...(extra?.notice === undefined ? {} : { notice: extra.notice }),
    }
  }

  /** Run the gate to completion: 'authenticated' lets Host boot proceed. */
  async run(): Promise<DesktopEnterpriseGateRunResult> {
    const preset = resolveEnterpriseGatewayPreset(this.deps.env ?? process.env)
    if (preset.status !== 'ok') {
      this.deps.logger.error(preset.status === 'missing'
        ? `${BIN_NAME}: enterprise gateway preset is missing; refusing to offer a manual input (R15)`
        : `${BIN_NAME}: enterprise gateway preset is invalid: ${preset.detail}`)
      this.serverOrigin = ''
      const window = await this.createGateWindow(this.windowInput('preset-missing'))
      await window.run()
      return { outcome: 'quit' }
    }
    this.serverOrigin = new URL(preset.gatewayUrl).origin
    this.presetUrl = preset.gatewayUrl
    this.presetClientId = preset.clientId

    let protectorAvailable = false
    try {
      protectorAvailable = typeof this.deps.protector.available === 'function'
        ? await this.deps.protector.available()
        : this.deps.protector.available
    } catch (cause) {
      this.deps.logger.error(`${BIN_NAME}: secret storage availability check failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
    if (!protectorAvailable) {
      this.deps.logger.error(`${BIN_NAME}: OS-backed secret storage is unavailable; enterprise sign-in cannot store tokens`)
      const window = await this.createGateWindow(this.windowInput('storage-unavailable'))
      await window.run()
      return { outcome: 'quit' }
    }

    const patchOutcome = await this.installMachinePatch(preset.gatewayUrl)
    if (patchOutcome === 'patch-failed' || patchOutcome.status === 'admin-file-kept') {
      const window = await this.createGateWindow(this.windowInput(
        patchOutcome === 'patch-failed' ? 'patch-failed' : 'patch-admin-kept',
      ))
      await window.run()
      return { outcome: 'quit' }
    }

    let tokens: EnterpriseTokenSet | undefined
    try {
      tokens = await readEnterpriseTokens(this.deps.userDataDir, this.deps.protector)
    } catch (cause) {
      if (cause instanceof EnterpriseTokenStoreError && cause.code === 'storage-unavailable') {
        const window = await this.createGateWindow(this.windowInput('storage-unavailable'))
        await window.run()
        return { outcome: 'quit' }
      }
      this.deps.logger.error(`${BIN_NAME}: stored enterprise tokens were unreadable; a fresh sign-in is required: ${cause instanceof Error ? cause.message : String(cause)}`)
      tokens = undefined
    }

    if (tokens !== undefined && tokens.gatewayUrl !== preset.gatewayUrl) {
      // A preset change (re-deployment) quietly invalidates the stored session.
      tokens = undefined
    }
    if (tokens !== undefined && !enterpriseTokenValidity(tokens, this.now()).accessValid) {
      // Expired access token with a refresh token: rotate silently first so a
      // returning user is not forced through the browser unnecessarily.
      const refreshed = await this.refreshExisting(tokens)
      tokens = refreshed ? await readEnterpriseTokens(this.deps.userDataDir, this.deps.protector).catch(() => undefined) : undefined
    }
    if (tokens !== undefined) {
      await this.establishSession()
      return { outcome: 'authenticated' }
    }

    return await this.runLoginWindow()
  }

  /** Refresh an expired-but-refreshable session without showing the window. */
  private async refreshExisting(tokens: EnterpriseTokenSet): Promise<boolean> {
    try {
      const response = await refreshEnterpriseTokens(this.transport, {
        gatewayUrl: tokens.gatewayUrl,
        clientId: tokens.clientId,
        refreshToken: tokens.refreshToken,
      })
      const now = this.now()
      const rotated = Object.freeze({
        ...tokens,
        accessToken: response.accessToken,
        refreshToken: response.refreshToken,
        expiresAt: now + response.expiresInSeconds * 1000,
        refreshAt: now + Math.floor(response.expiresInSeconds * 500),
        obtainedAt: now,
      })
      await saveEnterpriseTokens(this.deps.userDataDir, this.deps.protector, rotated)
      return true
    } catch (cause) {
      // Session data stays stored (brief 13.2); the user is guided to re-login.
      this.deps.logger.error(`${BIN_NAME}: enterprise session refresh failed; re-login required: ${cause instanceof Error ? cause.message : String(cause)}`)
      return false
    }
  }

  private async runLoginWindow(notice?: 'session-expired'): Promise<DesktopEnterpriseGateRunResult> {
    if (this.presetUrl === undefined || this.presetClientId === undefined) return { outcome: 'quit' }
    const ui: EnterpriseLoginUi = {
      show: (view: EnterpriseLoginView, context?: { readonly username?: string, readonly errorMessage?: string }) => {
        this.window?.showView(this.windowInput(view, {
          ...(context?.username === undefined ? {} : { username: context.username }),
          ...(context?.errorMessage === undefined ? {} : { errorMessage: context.errorMessage }),
          ...(view === 'success' || notice === undefined ? {} : { notice }),
        }))
      },
    }
    this.coordinator = new EnterpriseLoginCoordinator({
      locale: this.deps.locale,
      gatewayUrl: this.presetUrl,
      clientId: this.presetClientId,
      scope: ENTERPRISE_OAUTH_SCOPE,
      timeoutMs: this.timeoutMs,
      transport: this.transport,
      openBrowser: this.deps.openExternal,
      persistTokens: tokens => saveEnterpriseTokens(this.deps.userDataDir, this.deps.protector, tokens),
      now: this.now,
      log: this.deps.logger,
    }, ui)

    const window = await this.createGateWindow(this.windowInput('initial', notice === undefined ? {} : { notice }))
    let result: DesktopEnterpriseLoginResult
    try {
      result = await window.run()
    } finally {
      // The gate may have been disposed while the window was open; disposal
      // already cleared the coordinator in that case.
      this.coordinator?.dispose()
      this.coordinator = undefined
      this.window = undefined
    }
    if (result.action === 'quit') return { outcome: 'quit' }
    await this.establishSession()
    return { outcome: 'authenticated' }
  }

  /**
   * Refresh the identity projection and hand session establishment to the
   * launcher (first LLM-token issuance). Best-effort: a network failure here
   * degrades to a stale identity or an unissued token that the runtime chain
   * retries — it never turns a verified session into a login failure.
   */
  private async establishSession(): Promise<void> {
    this.sessionEstablished = true
    await this.updateIdentity()
    try {
      await this.deps.onSessionEstablished?.()
    } catch (cause) {
      this.deps.logger.error(`${BIN_NAME}: session establishment failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  /** Re-read userinfo with the current access token; keeps the last good identity on failure. */
  private async updateIdentity(): Promise<void> {
    const tokens = await readEnterpriseTokens(this.deps.userDataDir, this.deps.protector).catch(() => undefined)
    if (tokens === undefined || !enterpriseTokenValidity(tokens, this.now()).accessValid) return
    try {
      this.identity = await fetchEnterpriseIdentity(
        this.deps.identityTransport ?? fetchEnterpriseIdentityTransport,
        { gatewayUrl: tokens.gatewayUrl, accessToken: tokens.accessToken },
      )
    } catch (cause) {
      // Role changes surface on the next successful read; absence of network
      // must not disturb an otherwise valid session.
      this.deps.logger.error(`${BIN_NAME}: identity could not be refreshed: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  /**
   * Begin the background half-life refresh loop. On refresh failure the login
   * window reopens with a session-expired notice; stored tokens are kept
   * until a fresh login replaces them (brief 13.2).
   */
  startMaintenance(): void {
    if (this.presetUrl === undefined || this.presetClientId === undefined) return
    this.refresher?.stop()
    this.refresher = new EnterpriseTokenRefresher({
      gatewayUrl: this.presetUrl,
      clientId: this.presetClientId,
      transport: this.transport,
      read: () => readEnterpriseTokens(this.deps.userDataDir, this.deps.protector),
      save: tokens => saveEnterpriseTokens(this.deps.userDataDir, this.deps.protector, tokens),
      now: this.now,
      log: this.deps.logger,
      onRefreshFailed: () => { void this.requestReauth('session-expired') },
      onRefreshed: () => { void this.updateIdentity() },
    })
    this.refresher.start()
  }

  /**
   * Reopen the login window behind a re-login notice. Shared by the OAuth
   * refresh-failure path and the LLM token chain's 401 (session rejected)
   * path; concurrent requests collapse into the running one.
   */
  async requestReauth(notice: 'session-expired' = 'session-expired'): Promise<void> {
    if (this.reauthing) return
    this.reauthing = true
    try {
      this.sessionEstablished = false
      this.refresher?.stop()
      this.refresher = undefined
      const result = await this.runLoginWindow(notice)
      if (result.outcome === 'authenticated') this.startMaintenance()
      else this.deps.logger.error(`${BIN_NAME}: re-login was dismissed; the stored session remains until sign-in succeeds`)
    } finally {
      this.reauthing = false
    }
  }

  /**
   * Explicit sign-out (settings-page account area): revoke both tokens with
   * the gateway, clear the OS-backed store and the injected LLM token, and
   * return to the login window. Revocation is best-effort — the local cleanup
   * and the return to sign-in happen regardless of network outcome.
   */
  async signout(): Promise<void> {
    if (this.reauthing) return
    this.reauthing = true
    try {
      this.sessionEstablished = false
      this.refresher?.stop()
      this.refresher = undefined
      const tokens = await readEnterpriseTokens(this.deps.userDataDir, this.deps.protector).catch(() => undefined)
      if (tokens !== undefined && this.presetClientId !== undefined) {
        for (const [token, hint] of [[tokens.accessToken, 'access_token'], [tokens.refreshToken, 'refresh_token']] as const) {
          const revoked = await revokeEnterpriseToken(this.transport, {
            gatewayUrl: tokens.gatewayUrl,
            clientId: this.presetClientId,
            token,
            tokenTypeHint: hint,
          })
          if (!revoked) {
            this.deps.logger.error(`${BIN_NAME}: server-side revocation did not complete; the tokens are discarded locally regardless`)
          }
        }
      }
      try {
        await clearEnterpriseTokens(this.deps.userDataDir)
      } catch (cause) {
        this.deps.logger.error(`${BIN_NAME}: stored enterprise tokens could not be removed: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
      this.identity = undefined
      try {
        this.deps.onSessionEnded?.()
      } catch (cause) {
        this.deps.logger.error(`${BIN_NAME}: session teardown failed: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
      const result = await this.runLoginWindow()
      if (result.outcome === 'authenticated') this.startMaintenance()
      else this.deps.logger.error(`${BIN_NAME}: sign-out completed; the application stays on the sign-in window until a session is established`)
    } finally {
      this.reauthing = false
    }
  }

  /** Tear down windows, listeners, and timers (generation release in main). */
  dispose(): void {
    this.refresher?.stop()
    this.refresher = undefined
    this.coordinator?.dispose()
    this.coordinator = undefined
    this.window = undefined
  }
}
