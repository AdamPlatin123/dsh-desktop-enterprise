/**
 * Enterprise telemetry client (R10 minimal privacy telemetry): client version,
 * online status, and error counters, reported to the organization gateway at
 * `POST /api/desktop/telemetry` with the current OAuth access token — the
 * gateway identifies the report by the organization account behind the token,
 * so the payload itself carries no installation identifier.
 *
 * The module stays dormant unless a deployment presets the telemetry switch
 * (`resolveEnterpriseTelemetryPolicy`, default off): construction alone
 * performs zero network activity, and even a configured reporter only sends
 * on the scheduler's tick.
 */

/** Gateway path that receives telemetry reports (server side: R36). */
export const DESKTOP_ENTERPRISE_TELEMETRY_PATH = '/api/desktop/telemetry'

/** Fetch-compatible transport for one telemetry report; injectable for tests. */
export type EnterpriseTelemetryTransport = (
  url: string,
  init: { readonly method: 'POST', readonly headers: Record<string, string>, readonly body: string },
) => Promise<{ readonly status: number, readonly text: string }>

/** The three reported facets and nothing else (R10: minimal privacy telemetry). */
export interface EnterpriseTelemetrySnapshot {
  /** Running Desktop version string. */
  readonly clientVersion: string
  /** Whether the desktop client currently reaches its organization gateway. */
  readonly online: boolean
  /** Bounded per-kind error counters accumulated since the last report. */
  readonly errorCounts: Readonly<Record<string, number>>
}

/** One complete report body as the gateway receives it (exactly the three facets). */
export type EnterpriseTelemetryPayload = EnterpriseTelemetrySnapshot

/** Maximum distinct error kinds retained before the oldest are coalesced. */
export const MAX_TELEMETRY_ERROR_KINDS = 32
/** Maximum count recorded per error kind (saturating). */
export const MAX_TELEMETRY_ERROR_COUNT = 1_000_000

/** Validate one error kind label before it may enter a counter. */
export function validateTelemetryErrorKind(kind: string): string {
  if (kind.length === 0 || kind.length > 64 || !/^[A-Za-z0-9._-]+$/u.test(kind)) {
    throw new TypeError('telemetry error kinds must be 1-64 characters of [A-Za-z0-9._-]')
  }
  return kind
}

/**
 * Render one telemetry report as compact JSON.
 * @param input - the current snapshot; the payload is exactly its three facets.
 * @returns the serialized payload ready for a POST body.
 */
export function renderEnterpriseTelemetryPayload(input: {
  readonly snapshot: EnterpriseTelemetrySnapshot
}): string {
  const errorCounts: Record<string, number> = {}
  for (const kind of Object.keys(input.snapshot.errorCounts).sort()) {
    errorCounts[kind] = input.snapshot.errorCounts[kind] ?? 0
  }
  const payload: EnterpriseTelemetryPayload = {
    clientVersion: input.snapshot.clientVersion,
    online: input.snapshot.online === true,
    errorCounts,
  }
  return JSON.stringify(payload)
}

/** Dependencies of one telemetry reporter; all injectable for tests. */
export interface EnterpriseTelemetryReporterOptions {
  readonly transport?: EnterpriseTelemetryTransport
  readonly log?: { readonly error: (message: string) => void }
}

/** Reporting configuration supplied when a deployment enables telemetry. */
export interface EnterpriseTelemetryConfiguration {
  /** Organization gateway origin; reports go to `<gateway>/api/desktop/telemetry`. */
  readonly gatewayUrl: string
  /** Running Desktop version string. */
  readonly clientVersion: string
  /** Read the current OAuth access token (undefined while signed out). */
  readonly readAccessToken: () => Promise<string | undefined>
}

/**
 * Default-dormant telemetry reporter. Until `configure` is called the reporter
 * performs no network activity: `recordError` and `setOnline` only update
 * local counters, and `flush` resolves to false without sending. Construction
 * alone (the shipped default) therefore produces zero egress.
 */
export class EnterpriseTelemetryReporter {
  private readonly transport: EnterpriseTelemetryTransport
  private readonly log: { readonly error: (message: string) => void } | undefined
  private configuration: EnterpriseTelemetryConfiguration | undefined
  private online = false
  private readonly errorCounts = new Map<string, number>()
  private flushTask: Promise<boolean> | undefined

  constructor(options: EnterpriseTelemetryReporterOptions = {}) {
    this.transport = options.transport ?? (async (url, init) => {
      const response = await fetch(url, { method: init.method, headers: init.headers, body: init.body, cache: 'no-store' })
      return { status: response.status, text: await response.text() }
    })
    this.log = options.log
  }

  /** Whether a deployment configuration is active. */
  get enabled(): boolean {
    return this.configuration !== undefined
  }

  /** Validate and install the deployment configuration; reports may start. */
  configure(configuration: EnterpriseTelemetryConfiguration): void {
    const gateway = new URL(configuration.gatewayUrl)
    if (gateway.pathname !== '' && gateway.pathname !== '/') {
      throw new TypeError('the telemetry gateway must be an origin without a path')
    }
    this.configuration = Object.freeze({ ...configuration, gatewayUrl: gateway.origin })
  }

  /** Remove the deployment configuration; the reporter returns to dormancy. */
  disable(): void {
    this.configuration = undefined
  }

  /** Record one error occurrence under a validated kind label. */
  recordError(kind: string): void {
    validateTelemetryErrorKind(kind)
    const current = this.errorCounts.get(kind) ?? 0
    this.errorCounts.set(kind, Math.min(current + 1, MAX_TELEMETRY_ERROR_COUNT))
    if (this.errorCounts.size > MAX_TELEMETRY_ERROR_KINDS) {
      const oldest = this.errorCounts.keys().next().value
      if (oldest !== undefined && oldest !== kind) this.errorCounts.delete(oldest)
    }
  }

  /** Update the online facet observed by the caller. */
  setOnline(online: boolean): void {
    this.online = online === true
  }

  /** Current counters without sending; used by tests and diagnostics. */
  snapshot(clientVersion: string): EnterpriseTelemetrySnapshot {
    return Object.freeze({
      clientVersion,
      online: this.online,
      errorCounts: Object.freeze(Object.fromEntries(this.errorCounts)),
    })
  }

  /**
   * POST one report to the gateway. Dormant reporters resolve to false
   * without any network activity; so does a reporter without a current
   * access token (signed out). A failure is logged and reported as false
   * so telemetry can never surface as a user-facing error.
   */
  flush(): Promise<boolean> {
    if (this.flushTask !== undefined) return this.flushTask
    const configuration = this.configuration
    if (configuration === undefined) return Promise.resolve(false)
    const body = renderEnterpriseTelemetryPayload({
      snapshot: this.snapshot(configuration.clientVersion),
    })
    this.errorCounts.clear()
    const task = (async () => {
      let accessToken: string | undefined
      try {
        accessToken = await configuration.readAccessToken()
      } catch {
        accessToken = undefined
      }
      if (accessToken === undefined) return false
      try {
        const result = await this.transport(
          `${configuration.gatewayUrl}${DESKTOP_ENTERPRISE_TELEMETRY_PATH}`,
          {
            method: 'POST',
            headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
            body,
          },
        )
        return result.status >= 200 && result.status < 300
      } catch (cause) {
        this.log?.error(`enterprise telemetry report failed: ${cause instanceof Error ? cause.message : String(cause)}`)
        return false
      }
    })().finally(() => {
      if (this.flushTask === task) this.flushTask = undefined
    })
    this.flushTask = task
    return task
  }
}

/** Reporting cadence: one report every 15 minutes while a session is live. */
export const ENTERPRISE_TELEMETRY_INTERVAL_MS = 15 * 60 * 1000

/** Dependencies of the periodic telemetry scheduler; all injectable for tests. */
export interface EnterpriseTelemetrySchedulerOptions {
  readonly flush: () => Promise<boolean>
  readonly intervalMs?: number
  readonly log?: { readonly error: (message: string) => void }
}

/**
 * Owns exactly one pending telemetry timer. `start` reports immediately and
 * then on the fixed cadence; `stop` cancels the timer (sign-out, session
 * loss). A stopped scheduler cannot be restarted — a fresh login builds a
 * new one, mirroring the LLM token chain's per-session lifecycle.
 */
export class EnterpriseTelemetryScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private readonly flush: () => Promise<boolean>
  private readonly intervalMs: number
  private readonly log: { readonly error: (message: string) => void } | undefined

  constructor(options: EnterpriseTelemetrySchedulerOptions) {
    this.flush = options.flush
    this.intervalMs = options.intervalMs ?? ENTERPRISE_TELEMETRY_INTERVAL_MS
    this.log = options.log
  }

  /** Flush once, then schedule the periodic reports. */
  start(): void {
    if (this.stopped) return
    void this.flush().catch((cause: unknown) => {
      this.log?.error(`enterprise telemetry report failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    })
    this.schedule()
  }

  /** Cancel the pending timer; the scheduler cannot be restarted afterwards. */
  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private schedule(): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.stopped) return
      void this.flush().catch((cause: unknown) => {
        this.log?.error(`enterprise telemetry report failed: ${cause instanceof Error ? cause.message : String(cause)}`)
      })
      this.schedule()
    }, this.intervalMs)
    this.timer.unref?.()
  }
}
