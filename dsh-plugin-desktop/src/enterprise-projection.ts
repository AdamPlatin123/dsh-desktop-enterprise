/**
 * Enterprise session projection uplink (R39 third layer, client half).
 *
 * While the organization gateway has the projection policy on, the client
 * reports minimal session metadata — session start/end, cumulative tool
 * category counts, and a plugin inventory hash — to
 * `POST /api/sessions/desktop-events` with the current OAuth access token.
 * No conversation titles, no parameter values, no token usage: the server
 * ledger stays the single source of truth for consumption.
 *
 * Weak binding (organization policy `desktopEvents=on` makes model renewal
 * conditional on presence): the LLM token refresher submits a projection
 * batch right before every renewal — pending session events when there are
 * any, otherwise a single synthesized `heartbeat` row. Every batch carries
 * a monotonically increasing `seq` (the server keeps a per-uid cursor,
 * tolerates gaps, refuses regressions); an accepted batch refreshes the
 * server-side liveness that the renewal gate reads.
 *
 * The policy is discovered, not presumed: a `404` answer means the
 * deployment keeps reporting off, and the reporter goes silent (pending
 * events are dropped) until the next session start re-probes once. A `401`
 * or `403` keeps events queued — the OAuth session rotates and recovers on
 * its own, and the next flush sends what is still honest to send.
 */

import { createHash } from 'node:crypto'

/** Gateway path receiving projection batches (server side: R39). */
export const DESKTOP_ENTERPRISE_PROJECTION_PATH = '/api/sessions/desktop-events'

/** Event types the wire allows (server allowlist; R39 final schema). */
export type EnterpriseProjectionEventType = 'session.start' | 'session.end' | 'heartbeat'

/** One wire event. Optional facets are only set when the client knows them. */
export interface EnterpriseProjectionEvent {
  readonly sessionId: string
  readonly eventType: EnterpriseProjectionEventType
  /** Client clock milliseconds for the occurrence; the server stamps receipt. */
  readonly occurredAt: number
  /** Cumulative tool category counts accumulated since the session opened. */
  readonly toolCounts?: Readonly<Record<string, number>>
  /** SHA-256 of the sorted direct plugin-bundle inventory, when known. */
  readonly pluginHash?: string
}

/**
 * Session id carried by synthesized heartbeat rows when no organization
 * session is open (the server only requires a non-empty label; heartbeats
 * assert presence, not a session lifecycle).
 */
export const HEARTBEAT_SESSION_ID = 'heartbeat'

/** Fetch-compatible transport for one projection batch; injectable for tests. */
export type EnterpriseProjectionTransport = (
  url: string,
  init: { readonly method: 'POST', readonly headers: Record<string, string>, readonly body: string },
) => Promise<{ readonly status: number, readonly text: string }>

/** Server-side batch bounds the client mirrors (R39: 1..64 events per batch). */
export const ENTERPRISE_PROJECTION_BATCH_LIMIT = 64
/** Queued events retained across failed flushes; the oldest are dropped past this. */
export const MAX_PENDING_PROJECTION_EVENTS = 512

/** Dependencies of one projection reporter; all injectable for tests. */
export interface EnterpriseProjectionReporterOptions {
  readonly gatewayUrl: string
  readonly transport?: EnterpriseProjectionTransport
  /** Read the current OAuth access token (undefined while signed out). */
  readonly readAccessToken: () => Promise<string | undefined>
  readonly now?: () => number
  readonly log?: { readonly error: (message: string) => void }
}

/** Policy disposition as observed from the gateway's answers. */
export type EnterpriseProjectionPolicy = 'unknown' | 'on' | 'off'

/**
 * Event-driven projection reporter. Events are queued locally and flushed
 * eagerly on session transitions; between transitions nothing leaves the
 * process. Dormant states (signed out, policy off) produce zero egress.
 */
export class EnterpriseProjectionReporter {
  private readonly gatewayUrl: string
  private readonly transport: EnterpriseProjectionTransport
  private readonly readAccessToken: () => Promise<string | undefined>
  private readonly now: () => number
  private readonly log: { readonly error: (message: string) => void } | undefined
  private readonly pending: EnterpriseProjectionEvent[] = []
  private readonly toolCounts = new Map<string, number>()
  private pluginHash: string | undefined
  private policy: EnterpriseProjectionPolicy = 'unknown'
  private flushTask: Promise<boolean> | undefined
  /**
   * Next batch sequence number. Strictly increasing per organization
   * account: the server keeps a per-uid cursor, tolerates gaps, and refuses
   * regressions (`409 stale_seq`), so this never resets on clear() — a
   * rebase (server restart, another device) re-syncs it from the refusal.
   */
  private nextSeq = 1
  /** Most recent organization session id; heartbeat rows carry it when set. */
  private lastSessionId: string | undefined

  constructor(options: EnterpriseProjectionReporterOptions) {
    const gateway = new URL(options.gatewayUrl)
    if (gateway.pathname !== '' && gateway.pathname !== '/') {
      throw new TypeError('the projection gateway must be an origin without a path')
    }
    this.gatewayUrl = gateway.origin
    this.transport = options.transport ?? (async (url, init) => {
      const response = await fetch(url, { method: init.method, headers: init.headers, body: init.body, cache: 'no-store' })
      return { status: response.status, text: await response.text() }
    })
    this.readAccessToken = options.readAccessToken
    this.now = options.now ?? (() => Date.now())
    this.log = options.log
  }

  /** The policy disposition learned from gateway answers so far. */
  get policyState(): EnterpriseProjectionPolicy {
    return this.policy
  }

  /** Events waiting to be sent; used by tests and diagnostics. */
  get pendingCount(): number {
    return this.pending.length
  }

  /**
   * Record the organization session opening and flush eagerly. A previous
   * "policy off" verdict is reset once per session: a deployment that turns
   * reporting on is picked up at the next sign-in without a restart.
   */
  sessionStarted(sessionId: string): void {
    this.policy = 'unknown'
    this.lastSessionId = sessionId
    this.enqueue({ sessionId, eventType: 'session.start', occurredAt: this.now() })
  }

  /** Record the organization session closing and flush the tail eagerly. */
  sessionEnded(sessionId: string): void {
    this.lastSessionId = sessionId
    this.enqueue({ sessionId, eventType: 'session.end', occurredAt: this.now() })
  }

  /** Count one tool use under a bounded category label (reported with the next event). */
  recordToolUse(category: string): void {
    if (category.length === 0 || category.length > 128) return
    this.toolCounts.set(category, Math.min((this.toolCounts.get(category) ?? 0) + 1, 1_000_000))
  }

  /** Provide the plugin inventory hash carried by subsequent events. */
  setPluginHash(hash: string): void {
    this.pluginHash = hash
  }

  /** Drop every queued event and counters (used on sign-out bookkeeping). */
  clear(): void {
    this.pending.length = 0
    this.toolCounts.clear()
    // nextSeq deliberately survives clear(): the server-side per-uid cursor
    // outlives this process's queue, so sequence numbers must never go back.
  }

  /**
   * Renewal-time projection submit (weak binding): the token refresher
   * invokes this right before every LLM token issuance. Pending session
   * events are flushed as-is; with an empty queue a liveness-only heartbeat
   * row is synthesized so the renewal batch is never empty (the server
   * accepts batches of one and every accepted row refreshes liveness).
   * Resolves to whether a batch was accepted.
   */
  async submitHeartbeat(): Promise<boolean> {
    if (this.pending.length === 0 && this.policy !== 'off') {
      this.enqueue({
        sessionId: this.lastSessionId ?? HEARTBEAT_SESSION_ID,
        eventType: 'heartbeat',
        occurredAt: this.now(),
      })
    }
    return await this.flush()
  }

  /**
   * Send queued events. Policy-off and signed-out states resolve to false
   * without any network activity; a `404` verdict also drops the queue —
   * the deployment does not want these rows, so keeping them would only
   * retry forever. Auth and network failures keep the queue for the next
   * session transition. Every batch carries the monotonically increasing
   * `seq`; a `409 stale_seq` refusal rebases onto the server's lastSeq and
   * retries the same batch once (server restart, or another device of the
   * same account advanced the cursor).
   */
  flush(): Promise<boolean> {
    if (this.flushTask !== undefined) return this.flushTask
    if (this.policy === 'off' || this.pending.length === 0) return Promise.resolve(false)
    const task = (async () => {
      let accessToken: string | undefined
      try {
        accessToken = await this.readAccessToken()
      } catch {
        accessToken = undefined
      }
      if (accessToken === undefined) return false
      let rebaseUsed = false
      while (this.pending.length > 0) {
        if (this.policy === 'off') return false
        const batch = this.pending.slice(0, ENTERPRISE_PROJECTION_BATCH_LIMIT)
        const counts = Object.fromEntries([...this.toolCounts.entries()].sort(([a], [b]) => a.localeCompare(b)))
        const events = batch.map((event, index) => {
          if (index !== batch.length - 1) return event
          return {
            ...event,
            ...(Object.keys(counts).length > 0 ? { toolCounts: counts } : {}),
            ...(this.pluginHash !== undefined ? { pluginHash: this.pluginHash } : {}),
          }
        })
        let status: number
        try {
          const result = await this.transport(`${this.gatewayUrl}${DESKTOP_ENTERPRISE_PROJECTION_PATH}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
            body: JSON.stringify({ seq: this.nextSeq, events }),
          })
          status = result.status
          if (status === 409 && !rebaseUsed) {
            // Sequence regression: rebase onto the server's cursor and retry
            // the same batch once. The queue was not spliced, so the loop
            // re-sends exactly what was refused.
            let lastSeq: unknown
            try {
              lastSeq = (JSON.parse(result.text) as { lastSeq?: unknown }).lastSeq
            } catch {
              lastSeq = undefined
            }
            if (typeof lastSeq === 'number' && Number.isFinite(lastSeq) && lastSeq >= 0) {
              this.nextSeq = lastSeq + 1
              rebaseUsed = true
              continue
            }
          }
        } catch (cause) {
          this.log?.error(`enterprise projection report failed: ${cause instanceof Error ? cause.message : String(cause)}`)
          return false
        }
        if (status === 404) {
          // The organization policy is off: go silent and drop the queue.
          this.policy = 'off'
          this.pending.length = 0
          this.toolCounts.clear()
          return false
        }
        if (status === 401 || status === 403) {
          // The session is mid-rotation or the token lacks the scope; keep
          // the events for a later flush instead of dropping them.
          return false
        }
        if (status >= 200 && status < 300) {
          this.nextSeq += 1
          this.pending.splice(0, batch.length)
          this.toolCounts.clear()
          continue
        }
        // Transient rejection (rate limit, server error): keep and stop.
        this.log?.error(`enterprise projection report was rejected with HTTP ${String(status)}`)
        return false
      }
      return true
    })().finally(() => {
      if (this.flushTask === task) this.flushTask = undefined
    })
    this.flushTask = task
    return task
  }

  private enqueue(event: EnterpriseProjectionEvent): void {
    this.pending.push(event)
    if (this.pending.length > MAX_PENDING_PROJECTION_EVENTS) {
      this.pending.splice(0, this.pending.length - MAX_PENDING_PROJECTION_EVENTS)
    }
    void this.flush()
  }
}

/** SHA-256 over the sorted `packageName:status` inventory lines (client-side minimum). */
export function pluginInventoryHash(bundles: ReadonlyArray<{ readonly packageName: string, readonly status: string }>): string {
  const hash = createHash('sha256')
  for (const bundle of [...bundles].sort((a, b) => a.packageName.localeCompare(b.packageName))) {
    hash.update(`${bundle.packageName}:${bundle.status}\n`)
  }
  return hash.digest('hex')
}
