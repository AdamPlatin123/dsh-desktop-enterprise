import { describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_ENTERPRISE_TELEMETRY_PATH,
  EnterpriseTelemetryReporter,
  MAX_TELEMETRY_ERROR_COUNT,
  MAX_TELEMETRY_ERROR_KINDS,
  renderEnterpriseTelemetryPayload,
  validateTelemetryErrorKind,
} from '../src/enterprise-telemetry.ts'

const INSTALLATION_ID = '01234567-89ab-4cde-8f01-23456789abcd'

function okResponse(): Response {
  return new Response(null, { status: 202 })
}

describe('enterprise telemetry payload', () => {
  it('renders exactly the three facets plus the installation identity and timestamp', () => {
    const body = renderEnterpriseTelemetryPayload({
      installationId: INSTALLATION_ID,
      snapshot: {
        clientVersion: '2.0.4',
        online: true,
        errorCounts: { 'llm.401': 2, startup: 1 },
      },
      sentAt: new Date('2026-09-01T08:00:00.000Z'),
    })
    expect(JSON.parse(body)).toEqual({
      installationId: INSTALLATION_ID,
      clientVersion: '2.0.4',
      online: true,
      errorCounts: { 'llm.401': 2, startup: 1 },
      sentAt: '2026-09-01T08:00:00.000Z',
    })
    expect(Object.keys(JSON.parse(body)).sort()).toEqual([
      'clientVersion',
      'errorCounts',
      'installationId',
      'online',
      'sentAt',
    ])
  })

  it('normalizes facet values instead of echoing caller input', () => {
    const body = renderEnterpriseTelemetryPayload({
      installationId: INSTALLATION_ID,
      snapshot: {
        clientVersion: '2.0.4',
        online: 'yes' as unknown as boolean,
        errorCounts: { b: 1, a: 1 },
      },
      sentAt: new Date(0),
    })
    const parsed = JSON.parse(body) as { online: boolean, errorCounts: Record<string, number> }
    expect(parsed.online).toBe(false)
    expect(Object.keys(parsed.errorCounts)).toEqual(['a', 'b'])
  })
})

describe('enterprise telemetry reporter', () => {
  it('is dormant by default and performs no network activity', async () => {
    const transport = vi.fn(async () => okResponse())
    const reporter = new EnterpriseTelemetryReporter({ transport })
    expect(reporter.enabled).toBe(false)

    reporter.recordError('startup')
    reporter.setOnline(true)
    await expect(reporter.flush()).resolves.toBe(false)
    expect(transport).not.toHaveBeenCalled()

    // Disabling a configured reporter returns it to the same dormancy.
    reporter.configure({
      gatewayUrl: 'https://gateway.example.com',
      installationId: INSTALLATION_ID,
      clientVersion: '2.0.4',
    })
    expect(reporter.enabled).toBe(true)
    reporter.disable()
    expect(reporter.enabled).toBe(false)
    await expect(reporter.flush()).resolves.toBe(false)
    expect(transport).not.toHaveBeenCalled()
  })

  it('posts the accumulated report to the gateway telemetry path and clears counters', async () => {
    const bodies: string[] = []
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body))
      return okResponse()
    })
    const reporter = new EnterpriseTelemetryReporter({
      transport,
      now: () => new Date('2026-09-01T08:30:00.000Z'),
    })
    reporter.configure({
      gatewayUrl: 'https://gateway.example.com/',
      installationId: INSTALLATION_ID,
      clientVersion: '2.0.4',
    })
    reporter.setOnline(true)
    reporter.recordError('llm.401')
    reporter.recordError('llm.401')
    reporter.recordError('network')

    await expect(reporter.flush()).resolves.toBe(true)

    expect(transport).toHaveBeenCalledOnce()
    expect(transport.mock.calls[0]?.[0]).toBe(`https://gateway.example.com${DESKTOP_ENTERPRISE_TELEMETRY_PATH}`)
    const init = transport.mock.calls[0]?.[1] as RequestInit
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('content-type')).toBe('application/json')
    expect(JSON.parse(bodies[0] ?? '{}')).toEqual({
      installationId: INSTALLATION_ID,
      clientVersion: '2.0.4',
      online: true,
      errorCounts: { 'llm.401': 2, network: 1 },
      sentAt: '2026-09-01T08:30:00.000Z',
    })

    // Counters reset after a successful report.
    expect(reporter.snapshot('2.0.4').errorCounts).toEqual({})
  })

  it('treats transport failures as a silent false instead of a user-facing error', async () => {
    const log = { error: vi.fn() }
    const reporter = new EnterpriseTelemetryReporter({
      transport: async () => { throw new TypeError('offline') },
      log,
    })
    reporter.configure({
      gatewayUrl: 'https://gateway.example.com',
      installationId: INSTALLATION_ID,
      clientVersion: '2.0.4',
    })
    reporter.recordError('network')
    await expect(reporter.flush()).resolves.toBe(false)
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('offline'))
  })

  it('collapses concurrent flushes into one in-flight report', async () => {
    let release!: (response: Response) => void
    const transport = vi.fn(async () => new Promise<Response>(resolve => { release = resolve }))
    const reporter = new EnterpriseTelemetryReporter({ transport })
    reporter.configure({
      gatewayUrl: 'https://gateway.example.com',
      installationId: INSTALLATION_ID,
      clientVersion: '2.0.4',
    })
    const first = reporter.flush()
    const second = reporter.flush()
    expect(transport).toHaveBeenCalledOnce()
    release(okResponse())
    await Promise.all([first, second])
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
