/**
 * Enterprise telemetry client (R10 minimal privacy telemetry): client version,
 * online status, and error counters, reported to the organization gateway.
 *
 * The module is client-ready but deliberately dormant: nothing in the
 * application constructs a reporter yet. The reporting endpoint
 * (`POST /api/desktop/telemetry`) ships with the gateway side (T17); until a
 * deployment turns the surface on there, Desktop performs zero telemetry
 * egress — the compliance default is closed.
 */

/** Gateway path that will receive telemetry reports (server side: T17). */
export const DESKTOP_ENTERPRISE_TELEMETRY_PATH = '/api/desktop/telemetry'

/** Fetch-compatible transport for one telemetry report; injectable for tests. */
export type EnterpriseTelemetryTransport = (url: string, init: RequestInit) => Promise<Response>

/** The three reported facets and nothing else (R10: minimal privacy telemetry). */
export interface EnterpriseTelemetrySnapshot {
  /** Running Desktop version string. */
  readonly clientVersion: string
  /** Whether the desktop client currently reaches its organization gateway. */
  readonly online: boolean
  /** Bounded per-kind error counters accumulated since the last report. */
  readonly errorCounts: Readonly<Record<string, number>>
}

/** One complete report body as the gateway receives it. */
export interface EnterpriseTelemetryPayload extends EnterpriseTelemetrySnapshot {
  /** Installation UUID; visible to the gateway only while telemetry is on. */
  readonly installationId: string
  /** RFC 3339 UTC timestamp of the report. */
  readonly sentAt: string
}

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
 * @param input - installation identity, current snapshot, and report time.
 * @returns the serialized payload ready for a POST body.
 */
export function renderEnterpriseTelemetryPayload(input: {
  readonly installationId: string
  readonly snapshot: EnterpriseTelemetrySnapshot
  readonly sentAt: Date
}): string {
  const errorCounts: Record<string, number> = {}
  for (const kind of Object.keys(input.snapshot.errorCounts).sort()) {
    errorCounts[kind] = input.snapshot.errorCounts[kind] ?? 0
  }
  const payload: EnterpriseTelemetryPayload = {
    installationId: input.installationId,
    clientVersion: input.snapshot.clientVersion,
    online: input.snapshot.online === true,
    errorCounts,
    sentAt: input.sentAt.toISOString(),
  }
  return JSON.stringify(payload)
}

/** Dependencies of one telemetry reporter; all injectable for tests. */
export interface EnterpriseTelemetryReporterOptions {
  readonly transport?: EnterpriseTelemetryTransport
  readonly now?: () => Date
  readonly log?: { readonly error: (message: string) => void }
}

/** Reporting configuration supplied when a deployment enables telemetry. */
export interface EnterpriseTelemetryConfiguration {
  /** Organization gateway origin; reports go to `<gateway>/api/desktop/telemetry`. */
  readonly gatewayUrl: string
  /** Installation UUID carried in every report. */
  readonly installationId: string
  /** Running Desktop version string. */
  readonly clientVersion: string
}

/**
 * Default-dormant telemetry reporter. Until `configure` is called the reporter
 * performs no network activity: `recordError` and `setOnline` only update
 * local counters, and `flush` resolves to false without sending. Construction
 * alone (the shipped default) therefore produces zero egress.
 */
export class EnterpriseTelemetryReporter {
  private readonly transport: EnterpriseTelemetryTransport
  private readonly now: () => Date
  private readonly log: { readonly error: (message: string) => void } | undefined
  private configuration: EnterpriseTelemetryConfiguration | undefined
  private online = false
  private readonly errorCounts = new Map<string, number>()
  private flushTask: Promise<boolean> | undefined

  constructor(options: EnterpriseTelemetryReporterOptions = {}) {
    this.transport = options.transport ?? ((url, init) => globalThis.fetch(url, init))
    this.now = options.now ?? (() => new Date())
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
   * without any network activity; a failure is logged and reported as false
   * so telemetry can never surface as a user-facing error.
   */
  flush(): Promise<boolean> {
    if (this.flushTask !== undefined) return this.flushTask
    const configuration = this.configuration
    if (configuration === undefined) return Promise.resolve(false)
    const body = renderEnterpriseTelemetryPayload({
      installationId: configuration.installationId,
      snapshot: this.snapshot(configuration.clientVersion),
      sentAt: this.now(),
    })
    this.errorCounts.clear()
    const task = (async () => {
      try {
        const response = await this.transport(
          `${configuration.gatewayUrl}${DESKTOP_ENTERPRISE_TELEMETRY_PATH}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            cache: 'no-store',
            body,
          },
        )
        return response.status >= 200 && response.status < 300
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
