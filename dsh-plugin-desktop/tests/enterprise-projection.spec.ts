import { describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_ENTERPRISE_PROJECTION_PATH,
  EnterpriseProjectionReporter,
  ENTERPRISE_PROJECTION_BATCH_LIMIT,
  HEARTBEAT_SESSION_ID,
  MAX_PENDING_PROJECTION_EVENTS,
  pluginInventoryHash,
  type EnterpriseProjectionEvent,
} from '../src/enterprise-projection.ts'

interface RecordedRequest {
  readonly url: string
  readonly authorization: string | undefined
  readonly body: string
}

/** Build a reporter with a recording transport and a mutable token source. */
function buildReporter(overrides: {
  readonly responses?: Array<{ status: number, text?: string }>
  readonly accessToken?: string | undefined
  readonly log?: { readonly error: (message: string) => void }
} = {}): {
  readonly reporter: EnterpriseProjectionReporter
  readonly requests: RecordedRequest[]
  readonly setNetworkFailed: (failed: boolean) => void
  readonly setAccessToken: (token: string | undefined) => void
} {
  const requests: RecordedRequest[] = []
  const queue = [...(overrides.responses ?? [])]
  let failing = false
  const transport = vi.fn(async (url: string, init: { readonly headers: Record<string, string>, readonly body: string }) => {
    if (failing) throw new TypeError('offline')
    requests.push({ url, authorization: init.headers.authorization, body: init.body })
    const next = queue.shift()
    return { status: next?.status ?? 201, text: next?.text ?? '' }
  })
  let accessToken: string | undefined = 'accessToken' in overrides ? overrides.accessToken : 'at-1'
  const reporter = new EnterpriseProjectionReporter({
    gatewayUrl: 'https://gateway.example.com',
    transport,
    readAccessToken: async () => accessToken,
    now: () => 1_700_000_000_000,
    ...(overrides.log === undefined ? {} : { log: overrides.log }),
  })
  return {
    reporter,
    requests,
    setNetworkFailed: failed => { failing = failed },
    setAccessToken: token => { accessToken = token },
  }
}

function parseEvents(body: string): Array<Record<string, unknown>> {
  return (JSON.parse(body) as { events: Array<Record<string, unknown>> }).events
}

function parseBatch(body: string): { seq: number, events: Array<Record<string, unknown>> } {
  return JSON.parse(body) as { seq: number, events: Array<Record<string, unknown>> }
}

describe('enterprise projection payload', () => {
  it('posts session events to the desktop-events path with the bearer token', async () => {
    const { reporter, requests } = buildReporter()
    reporter.sessionStarted('sess-1')
    await expect(vi.waitFor(() => reporter.flush())).resolves.toBe(true)

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe(`https://gateway.example.com${DESKTOP_ENTERPRISE_PROJECTION_PATH}`)
    expect(requests[0]?.authorization).toBe('Bearer at-1')
    expect(parseEvents(requests[0]?.body ?? '{}')).toEqual([
      { sessionId: 'sess-1', eventType: 'session.start', occurredAt: 1_700_000_000_000 },
    ])
  })

  it('carries cumulative tool counts and the plugin hash on the batch tail', async () => {
    const { reporter, requests } = buildReporter()
    reporter.setPluginHash('a'.repeat(64))
    reporter.recordToolUse('bash')
    reporter.recordToolUse('bash')
    reporter.recordToolUse('read')
    reporter.sessionStarted('sess-1')
    reporter.sessionEnded('sess-1')
    await expect(vi.waitFor(() => reporter.flush())).resolves.toBe(true)

    expect(requests).toHaveLength(1)
    const events = parseEvents(requests[0]?.body ?? '{}')
    expect(events).toHaveLength(2)
    // Facets ride the last event of the batch only.
    expect(events[0]).not.toHaveProperty('toolCounts')
    expect(events[1]).toMatchObject({
      sessionId: 'sess-1',
      eventType: 'session.end',
      toolCounts: { bash: 2, read: 1 },
      pluginHash: 'a'.repeat(64),
    })
  })
})

describe('enterprise projection policy discovery', () => {
  it('goes silent when the gateway answers 404 (policy off) and drops the queue', async () => {
    const { reporter, requests } = buildReporter({ responses: [{ status: 404 }] })
    reporter.sessionStarted('sess-1')
    await expect(vi.waitFor(() => reporter.flush())).resolves.toBe(false)

    expect(requests).toHaveLength(1)
    expect(reporter.policyState).toBe('off')
    expect(reporter.pendingCount).toBe(0)

    // Further transitions produce zero network activity while the verdict stands.
    const before = requests.length
    reporter.sessionEnded('sess-1')
    await reporter.flush()
    expect(requests).toHaveLength(before)
  })

  it('re-probes once at the next session start after a policy-off verdict', async () => {
    const { reporter, requests } = buildReporter({ responses: [{ status: 404 }] })
    reporter.sessionStarted('sess-1')
    await reporter.flush()
    expect(reporter.policyState).toBe('off')

    reporter.sessionStarted('sess-2')
    await expect(vi.waitFor(() => reporter.flush())).resolves.toBe(true)
    expect(reporter.policyState).toBe('unknown')
    expect(parseEvents(requests[1]?.body ?? '{}')[0]).toMatchObject({ sessionId: 'sess-2' })
  })

  it('keeps the queue on auth rejections and sends later after rotation', async () => {
    const { reporter, requests } = buildReporter({ responses: [{ status: 401 }, { status: 201 }] })
    reporter.sessionStarted('sess-1')
    await expect(vi.waitFor(() => reporter.flush())).resolves.toBe(false)
    expect(reporter.pendingCount).toBe(1)

    reporter.sessionEnded('sess-1')
    await expect(vi.waitFor(() => reporter.flush())).resolves.toBe(true)
    expect(requests).toHaveLength(2)
    expect(parseEvents(requests[1]?.body ?? '{}')).toHaveLength(2)
  })

  it('keeps the queue through a network failure and reports the failure silently', async () => {
    const log = { error: vi.fn() }
    const { reporter, setNetworkFailed } = buildReporter({ log })
    setNetworkFailed(true)
    reporter.sessionStarted('sess-1')
    await vi.waitFor(() => expect(log.error).toHaveBeenCalledWith(expect.stringContaining('offline')))
    expect(reporter.pendingCount).toBe(1)

    setNetworkFailed(false)
    reporter.sessionEnded('sess-1')
    await expect(vi.waitFor(() => reporter.flush())).resolves.toBe(true)
  })

  it('keeps the queue through a transient server rejection', async () => {
    const { reporter } = buildReporter({ responses: [{ status: 429 }, { status: 201 }] })
    reporter.sessionStarted('sess-1')
    await expect(vi.waitFor(() => reporter.flush())).resolves.toBe(false)
    expect(reporter.pendingCount).toBe(1)

    reporter.sessionEnded('sess-1')
    await expect(vi.waitFor(() => reporter.flush())).resolves.toBe(true)
  })

  it('sends nothing while signed out and keeps the events queued', async () => {
    const { reporter, requests } = buildReporter({ accessToken: undefined })
    reporter.sessionStarted('sess-1')
    await expect(reporter.flush()).resolves.toBe(false)
    expect(requests).toHaveLength(0)
    expect(reporter.pendingCount).toBe(1)
  })

  it('splits a backlog beyond the server batch limit across requests', async () => {
    const { reporter, requests, setNetworkFailed } = buildReporter()
    // Network down: transitions queue without sending. Build a backlog of
    // exactly one batch plus one event.
    setNetworkFailed(true)
    for (let index = 0; index < ENTERPRISE_PROJECTION_BATCH_LIMIT + 1; index += 1) {
      reporter.sessionStarted(`sess-${String(index)}`)
    }
    expect(reporter.pendingCount).toBe(ENTERPRISE_PROJECTION_BATCH_LIMIT + 1)
    setNetworkFailed(false)
    await expect(reporter.flush()).resolves.toBe(true)
    expect(requests).toHaveLength(2)
    expect(parseEvents(requests[0]?.body ?? '{}')).toHaveLength(ENTERPRISE_PROJECTION_BATCH_LIMIT)
    expect(parseEvents(requests[1]?.body ?? '{}')).toHaveLength(1)
  })

  it('bounds the pending queue and drops the oldest events past it', async () => {
    const { reporter, requests, setNetworkFailed } = buildReporter()
    setNetworkFailed(true)
    for (let index = 0; index < MAX_PENDING_PROJECTION_EVENTS + 50; index += 1) {
      reporter.recordToolUse('bash')
      reporter.sessionStarted(`sess-${String(index)}`)
      reporter.sessionEnded(`sess-${String(index)}`)
    }
    expect(reporter.pendingCount).toBeLessThanOrEqual(MAX_PENDING_PROJECTION_EVENTS)
    setNetworkFailed(false)
    await expect(reporter.flush()).resolves.toBe(true)
    expect(requests.length).toBeGreaterThan(0)
  })

  it('clears queued events and counters on clear()', async () => {
    const { reporter, requests } = buildReporter({ accessToken: undefined })
    reporter.sessionStarted('sess-1')
    // Let the eager flush attempt settle (it cannot send while signed out).
    await reporter.flush()
    expect(reporter.pendingCount).toBe(1)
    reporter.recordToolUse('bash')
    reporter.clear()
    expect(reporter.pendingCount).toBe(0)
    await expect(reporter.flush()).resolves.toBe(false)
    expect(requests).toHaveLength(0)
  })

  it('rejects a gateway URL that is not a bare origin', () => {
    expect(() => new EnterpriseProjectionReporter({
      gatewayUrl: 'https://gateway.example.com/with/path',
      readAccessToken: async () => undefined,
    })).toThrow(TypeError)
  })
})

describe('plugin inventory hash', () => {
  it('is stable across input order and sensitive to content', () => {
    const first = pluginInventoryHash([
      { packageName: '@deepseek-ai/dsh-desktop-app', status: 'active' },
      { packageName: 'dsh-market', status: 'disabled' },
    ])
    const second = pluginInventoryHash([
      { packageName: 'dsh-market', status: 'disabled' },
      { packageName: '@deepseek-ai/dsh-desktop-app', status: 'active' },
    ])
    expect(first).toBe(second)
    expect(first).toMatch(/^[0-9a-f]{64}$/u)
    expect(pluginInventoryHash([{ packageName: 'dsh-market', status: 'active' }])).not.toBe(first)
  })

  it('distinguishes status changes for the same package', () => {
    const active = pluginInventoryHash([{ packageName: 'p', status: 'active' }])
    const disabled = pluginInventoryHash([{ packageName: 'p', status: 'disabled' }])
    expect(active).not.toBe(disabled)
  })
})

describe('projection batch sequence and heartbeat', () => {
  it('numbers batches with a strictly increasing seq across flushes', async () => {
    const { reporter, requests, setNetworkFailed } = buildReporter()
    setNetworkFailed(true)
    reporter.sessionStarted('sess-1')
    reporter.sessionEnded('sess-1')
    setNetworkFailed(false)
    await expect(reporter.flush()).resolves.toBe(true)
    // The backlog drains as one batch carrying the first sequence number.
    expect(requests).toHaveLength(1)
    expect(parseBatch(requests[0]?.body ?? '{}').seq).toBe(1)
    // The next flush continues the sequence — clear() does not reset it.
    reporter.clear()
    reporter.sessionStarted('sess-2')
    await expect(vi.waitFor(() => reporter.flush())).resolves.toBe(true)
    expect(parseBatch(requests[1]?.body ?? '{}').seq).toBe(2)
  })

  it('rebases onto the server cursor on 409 stale_seq and retries the same batch once', async () => {
    const { reporter, requests } = buildReporter({
      responses: [
        { status: 409, text: JSON.stringify({ error: 'stale_seq', lastSeq: 7 }) },
        { status: 201 },
      ],
    })
    reporter.sessionStarted('sess-1')
    await expect(vi.waitFor(() => reporter.flush())).resolves.toBe(true)
    expect(requests).toHaveLength(2)
    // The refused batch carried the local seq; the retry carried the rebased
    // one and shipped exactly the same events.
    expect(parseBatch(requests[0]?.body ?? '{}').seq).toBe(1)
    const retried = parseBatch(requests[1]?.body ?? '{}')
    expect(retried.seq).toBe(8)
    expect(retried.events).toEqual(parseBatch(requests[0]?.body ?? '{}').events)
    // The following batch continues from the rebased cursor.
    reporter.sessionEnded('sess-1')
    await expect(vi.waitFor(() => reporter.flush())).resolves.toBe(true)
    expect(parseBatch(requests[2]?.body ?? '{}').seq).toBe(9)
  })

  it('keeps the queue when a 409 carries no usable cursor (retries later)', async () => {
    const { reporter, requests } = buildReporter({
      responses: [
        { status: 409, text: 'not json' },
        { status: 201 },
      ],
    })
    reporter.sessionStarted('sess-1')
    await expect(vi.waitFor(() => reporter.flush())).resolves.toBe(false)
    expect(reporter.pendingCount).toBe(1)
    reporter.sessionEnded('sess-1')
    await expect(vi.waitFor(() => reporter.flush())).resolves.toBe(true)
    // Both flush attempts used the same next seq (the refusal must not have
    // advanced the local counter), and the second attempt succeeded.
    expect(parseBatch(requests[0]?.body ?? '{}').seq).toBe(1)
    expect(parseBatch(requests[1]?.body ?? '{}').seq).toBe(1)
  })

  it('synthesizes a heartbeat row for the renewal submit when nothing is pending', async () => {
    const { reporter, requests } = buildReporter()
    await expect(reporter.submitHeartbeat()).resolves.toBe(true)
    expect(requests).toHaveLength(1)
    const batch = parseBatch(requests[0]?.body ?? '{}')
    expect(batch.seq).toBe(1)
    expect(batch.events).toEqual([
      { sessionId: HEARTBEAT_SESSION_ID, eventType: 'heartbeat', occurredAt: 1_700_000_000_000 },
    ])
    // A subsequent heartbeat continues the sequence.
    await expect(reporter.submitHeartbeat()).resolves.toBe(true)
    expect(parseBatch(requests[1]?.body ?? '{}').seq).toBe(2)
  })

  it('carries the last known session id on synthesized heartbeats', async () => {
    const { reporter, requests } = buildReporter()
    reporter.sessionStarted('sess-9')
    await expect(vi.waitFor(() => reporter.flush())).resolves.toBe(true)
    await expect(reporter.submitHeartbeat()).resolves.toBe(true)
    const heartbeat = parseBatch(requests[1]?.body ?? '{}').events[0]
    expect(heartbeat).toMatchObject({ sessionId: 'sess-9', eventType: 'heartbeat' })
  })

  it('flushes pending session events as-is on submitHeartbeat without synthesizing', async () => {
    const { reporter, requests, setAccessToken } = buildReporter({ accessToken: undefined })
    reporter.sessionStarted('sess-1')
    await reporter.flush()
    expect(reporter.pendingCount).toBe(1)
    setAccessToken('at-1')
    await expect(reporter.submitHeartbeat()).resolves.toBe(true)
    expect(requests).toHaveLength(1)
    const events = parseBatch(requests[0]?.body ?? '{}').events
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ eventType: 'session.start', sessionId: 'sess-1' })
  })

  it('sends nothing on submitHeartbeat while the policy is off', async () => {
    const { reporter, requests } = buildReporter({ responses: [{ status: 404 }] })
    reporter.sessionStarted('sess-1')
    await expect(vi.waitFor(() => reporter.flush())).resolves.toBe(false)
    expect(reporter.policyState).toBe('off')
    const before = requests.length
    await expect(reporter.submitHeartbeat()).resolves.toBe(false)
    expect(requests).toHaveLength(before)
  })
})

describe('event type coverage', () => {
  it('only ever produces wire-allowlisted event types', async () => {
    const { reporter, requests } = buildReporter()
    reporter.sessionStarted('s1')
    reporter.sessionEnded('s1')
    await expect(vi.waitFor(() => reporter.flush())).resolves.toBe(true)
    const events: EnterpriseProjectionEvent[] = requests.flatMap(request => JSON.parse(request.body).events)
    expect(events.every(event => event.eventType === 'session.start' || event.eventType === 'session.end')).toBe(true)
  })
})
