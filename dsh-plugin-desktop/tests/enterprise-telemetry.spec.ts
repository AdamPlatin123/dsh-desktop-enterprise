import { describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_ENTERPRISE_TELEMETRY_PATH,
  EnterpriseTelemetryReporter,
  EnterpriseTelemetryScheduler,
  MAX_TELEMETRY_ERROR_COUNT,
  MAX_TELEMETRY_ERROR_KINDS,
  renderEnterpriseTelemetryPayload,
  validateTelemetryErrorKind,
} from '../src/enterprise-telemetry.ts'

interface RecordedRequest {
  readonly url: string
  readonly authorization: string | undefined
  readonly body: string
}

function okStatus(): number {
  return 202
}

describe('enterprise telemetry payload', () => {
  it('renders exactly the three facets — no installation id, no timestamp', () => {
    const body = renderEnterpriseTelemetryPayload({
      snapshot: {
        clientVersion: '2.0.4',
        online: true,
        errorCounts: { 'llm.401': 2, startup: 1 },
      },
    })
    expect(JSON.parse(body)).toEqual({
      clientVersion: '2.0.4',
      online: true,
      errorCounts: { 'llm.401': 2, startup: 1 },
    })
    expect(Object.keys(JSON.parse(body)).sort()).toEqual([
      'clientVersion',
      'errorCounts',
      'online',
    ])
  })

  it('normalizes facet values instead of echoing caller input', () => {
    const body = renderEnterpriseTelemetryPayload({
      snapshot: {
        clientVersion: '2.0.4',
        online: 'yes' as unknown as boolean,
        errorCounts: { b: 1, a: 1 },
      },
    })
    const parsed = JSON.parse(body) as { online: boolean, errorCounts: Record<string, number> }
    expect(parsed.online).toBe(false)
    expect(Object.keys(parsed.errorCounts)).toEqual(['a', 'b'])
  })
})

describe('enterprise telemetry reporter', () => {
  it('is dormant by default and performs no network activity', async () => {
    const transport = vi.fn(async () => ({ status: okStatus(), text: '' }))
    const reporter = new EnterpriseTelemetryReporter({ transport })
    expect(reporter.enabled).toBe(false)

    reporter.recordError('startup')
    reporter.setOnline(true)
    await expect(reporter.flush()).resolves.toBe(false)
    expect(transport).not.toHaveBeenCalled()

    // Disabling a configured reporter returns it to the same dormancy.
    reporter.configure({
      gatewayUrl: 'https://gateway.example.com',
      clientVersion: '2.0.4',
      readAccessToken: async () => 'at-1',
    })
    expect(reporter.enabled).toBe(true)
    reporter.disable()
    expect(reporter.enabled).toBe(false)
    await expect(reporter.flush()).resolves.toBe(false)
    expect(transport).not.toHaveBeenCalled()
  })

  it('posts the three-facet report with the bearer token and clears counters', async () => {
    const requests: RecordedRequest[] = []
    const transport = vi.fn(async (url: string, init: { readonly headers: Record<string, string>, readonly body: string }) => {
      requests.push({
        url,
        authorization: init.headers.authorization,
        body: init.body,
      })
      return { status: okStatus(), text: '' }
    })
    const reporter = new EnterpriseTelemetryReporter({ transport })
    reporter.configure({
      gatewayUrl: 'https://gateway.example.com/',
      clientVersion: '2.0.4',
      readAccessToken: async () => 'at-1',
    })
    reporter.setOnline(true)
    reporter.recordError('llm.401')
    reporter.recordError('llm.401')
    reporter.recordError('network')

    await expect(reporter.flush()).resolves.toBe(true)

    expect(transport).toHaveBeenCalledOnce()
    expect(requests[0]?.url).toBe(`https://gateway.example.com${DESKTOP_ENTERPRISE_TELEMETRY_PATH}`)
    expect(requests[0]?.authorization).toBe('Bearer at-1')
    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({
      clientVersion: '2.0.4',
      online: true,
      errorCounts: { 'llm.401': 2, network: 1 },
    })

    // Counters reset after a successful report.
    expect(reporter.snapshot('2.0.4').errorCounts).toEqual({})
  })

  it('sends nothing while signed out and keeps the counters for later', async () => {
    const transport = vi.fn(async () => ({ status: okStatus(), text: '' }))
    let accessToken: string | undefined
    const reporter = new EnterpriseTelemetryReporter({ transport })
    reporter.configure({
      gatewayUrl: 'https://gateway.example.com',
      clientVersion: '2.0.4',
      readAccessToken: async () => accessToken,
    })
    reporter.recordError('network')

    await expect(reporter.flush()).resolves.toBe(false)
    expect(transport).not.toHaveBeenCalled()

    // A later sign-in makes the same report sendable.
    accessToken = 'at-2'
    await expect(reporter.flush()).resolves.toBe(true)
    expect(transport).toHaveBeenCalledOnce()
  })

  it('treats transport failures as a silent false instead of a user-facing error', async () => {
    const log = { error: vi.fn() }
    const reporter = new EnterpriseTelemetryReporter({
      transport: async () => { throw new TypeError('offline') },
      log,
    })
    reporter.configure({
      gatewayUrl: 'https://gateway.example.com',
      clientVersion: '2.0.4',
      readAccessToken: async () => 'at-1',
    })
    reporter.recordError('network')
    await expect(reporter.flush()).resolves.toBe(false)
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('offline'))
  })

  it('collapses concurrent flushes into one in-flight report', async () => {
    let release!: (result: { status: number, text: string }) => void
    const transport = vi.fn(async () => new Promise<{ status: number, text: string }>(resolve => { release = resolve }))
    const reporter = new EnterpriseTelemetryReporter({ transport })
    reporter.configure({
      gatewayUrl: 'https://gateway.example.com',
      clientVersion: '2.0.4',
      readAccessToken: async () => 'at-1',
    })
    const first = reporter.flush()
    const second = reporter.flush()
    await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce())
    release({ status: okStatus(), text: '' })
    await Promise.all([first, second])
    expect(transport).toHaveBeenCalledOnce()
  })

  it('rejects malformed error kinds and saturates counters', () => {
    expect(() => validateTelemetryErrorKind('bad kind!')).toThrow()
    expect(() => validateTelemetryErrorKind('')).toThrow()
    expect(() => validateTelemetryErrorKind('x'.repeat(65))).toThrow()
    expect(validateTelemetryErrorKind('llm.401_revoked')).toBe('llm.401_revoked')

    const reporter = new EnterpriseTelemetryReporter()
    for (let index = 0; index < MAX_TELEMETRY_ERROR_COUNT + 10; index += 1) {
      reporter.recordError('llm.401')
    }
    expect(reporter.snapshot('2.0.4').errorCounts['llm.401']).toBe(MAX_TELEMETRY_ERROR_COUNT)
  })

  it('retains at most a bounded number of distinct error kinds', () => {
    const reporter = new EnterpriseTelemetryReporter()
    for (let index = 0; index < MAX_TELEMETRY_ERROR_KINDS + 4; index += 1) {
      reporter.recordError(`kind.${String(index)}`)
    }
    const counts = reporter.snapshot('2.0.4').errorCounts
    expect(Object.keys(counts)).toHaveLength(MAX_TELEMETRY_ERROR_KINDS)
  })
})

describe('enterprise telemetry scheduler', () => {
  it('flushes immediately, then on the cadence, and stops cleanly', async () => {
    vi.useFakeTimers()
    try {
      const flush = vi.fn(async () => true)
      const scheduler = new EnterpriseTelemetryScheduler({ flush, intervalMs: 1000 })
      scheduler.start()
      // The immediate flush is awaited by the scheduler internally; give the
      // microtask queue one turn.
      await vi.advanceTimersByTimeAsync(0)
      expect(flush).toHaveBeenCalledOnce()

      await vi.advanceTimersByTimeAsync(1000)
      expect(flush).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1000)
      expect(flush).toHaveBeenCalledTimes(3)

      scheduler.stop()
      await vi.advanceTimersByTimeAsync(5000)
      expect(flush).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cannot be restarted after stop', () => {
    vi.useFakeTimers()
    try {
      const flush = vi.fn(async () => true)
      const scheduler = new EnterpriseTelemetryScheduler({ flush, intervalMs: 1000 })
      scheduler.stop()
      scheduler.start()
      expect(flush).not.toHaveBeenCalled()
      vi.advanceTimersByTime(5000)
      expect(flush).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
