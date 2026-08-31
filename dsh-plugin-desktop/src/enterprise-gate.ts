/** Pre-Host enterprise login gate: session check, four-state window, refresh loop. */

import type { DesktopLocale } from './runtime.ts'
import { resolveEnterpriseGatewayPreset, ENTERPRISE_OAUTH_SCOPE } from './enterprise-gateway-preset.ts'
import { fetchEnterpriseTokenTransport, refreshEnterpriseTokens, type EnterpriseTokenTransport } from './enterprise-oauth.ts'
import { ENTERPRISE_LOGIN_TIMEOUT_MS } from './enterprise-loopback-callback.ts'
import { EnterpriseTokenRefresher } from './enterprise-token-refresher.ts'
import {
  EnterpriseTokenStoreError,
  enterpriseTokenValidity,
  readEnterpriseTokens,
  saveEnterpriseTokens,
  type EnterpriseTokenSet,
} from './enterprise-token-store.ts'
import type { DesktopLanHttpsPrivateKeyProtector } from './lan-https-certificate.ts'
import type { EnterpriseLoginView } from './enterprise-login-copy.ts'
import { EnterpriseLoginCoordinator, type EnterpriseLoginUi } from './enterprise-login-coordinator.ts'
import { renderEnterpriseMachinePatch, writeEnterpriseMachinePatch } from './enterprise-cordis-patch.ts'
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

  constructor(private readonly deps: DesktopEnterpriseGateDeps) {
    this.transport = deps.transport ?? fetchEnterpriseTokenTransport
    this.now = deps.now ?? (() => Date.now())
    this.timeoutMs = deps.timeoutMs ?? ENTERPRISE_LOGIN_TIMEOUT_MS
  }

  /** Surface for main's activation/second-instance reveal chain. */
  showSurface(): boolean {
    if (this.window === undefined) return false
    this.window.show()
    return true
  }

  /** Install the machine patch (13.3); failures log but do not block login. */
  private async installMachinePatch(gatewayUrl: string): Promise<void> {
    const document = renderEnterpriseMachinePatch({ gatewayUrl })
    const write = this.deps.patchWriter ?? writeEnterpriseMachinePatch
    try {
      const outcome = await write(this.deps.homeDir, document)
      if (outcome.status === 'admin-file-kept') {
        this.deps.logger.error(`${BIN_NAME}: an admin-authored cordis.patch.yml exists in the DSH home; the enterprise model route was not applied`)
      }
    } catch (cause) {
      this.deps.logger.error(`${BIN_NAME}: machine patch could not be written: ${cause instanceof Error ? cause.message : String(cause)}`)
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

    await this.installMachinePatch(preset.gatewayUrl)

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
    if (tokens !== undefined) return { outcome: 'authenticated' }

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
    return { outcome: 'authenticated' }
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
      onRefreshFailed: () => { void this.reauthAfterRefreshFailure() },
    })
    this.refresher.start()
  }

  private async reauthAfterRefreshFailure(): Promise<void> {
    if (this.reauthing) return
    this.reauthing = true
    try {
      this.refresher?.stop()
      this.refresher = undefined
      const result = await this.runLoginWindow('session-expired')
      if (result.outcome === 'authenticated') this.startMaintenance()
      else this.deps.logger.error(`${BIN_NAME}: re-login was dismissed; the stored session remains until sign-in succeeds`)
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
