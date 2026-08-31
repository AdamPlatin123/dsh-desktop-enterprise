import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EnterpriseLlmTokenError, type EnterpriseLlmToken } from '../src/enterprise-llm-tokens.ts'
import { EnterpriseLlmTokenRefresher } from '../src/enterprise-llm-token-refresher.ts'

interface HarnessOptions {
  readonly signedOut?: boolean
  readonly issued?: () => EnterpriseLlmToken
  readonly failWith?: () => unknown
  readonly retryDelayMs?: number
  readonly maxRetryDelayMs?: number
}

function harness({ signedOut = false, issued, failWith, retryDelayMs, maxRetryDelayMs }: HarnessOptions = {}) {
  let currentMs = 1_000_000
  const applied: EnterpriseLlmToken[] = []
  const issue = vi.fn(async (): Promise<EnterpriseLlmToken> => {
    if (failWith !== undefined) throw failWith()
    return issued !== undefined
      ? issued()
      : { token: `v1.g${String(issue.mock.calls.length)}`, expiresAt: currentMs + 100_000, generation: issue.mock.calls.length }
  })
  const apply = vi.fn((token: EnterpriseLlmToken) => { applied.push(token) })
  const onUnauthorized = vi.fn()
  const log = { error: vi.fn(), warn: vi.fn() }
  const refresher = new EnterpriseLlmTokenRefresher({
    gatewayUrl: 'https://gateway.example.com',
    readAccessToken: async () => (signedOut ? undefined : 'oauth-current'),
    issue,
    apply,
    now: () => currentMs,
    ...(retryDelayMs === undefined ? {} : { retryDelayMs }),
    ...(maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs }),
    log,
    onUnauthorized,
  })
  return {
    refresher,
    issue,
    apply,
    applied,
    onUnauthorized,
    log,
    advance: (ms: number) => { currentMs += ms },
  }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

/** Drain the microtask chain (readAccessToken -> issue -> apply) without touching virtual timers. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

describe('enterprise llm token refresher', () => {
  it('issues immediately on start, applies hot, and reschedules at half-life', async () => {
    const state = harness()
    state.refresher.start()
    await flush()
    expect(state.issue).toHaveBeenCalledTimes(1)
    expect(state.applied).toHaveLength(1)
    expect(state.applied[0]?.token).toBe('v1.g1')
    // TTL 100s -> half-life 50s; nothing happens before it.
    await state.advance(49_999)
    await vi.advanceTimersByTimeAsync(49_999)
    expect(state.issue).toHaveBeenCalledTimes(1)
    await state.advance(1)
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(state.issue).toHaveBeenCalledTimes(2)
    expect(state.applied[1]?.token).toBe('v1.g2')
    state.refresher.stop()
  })

  it('collapses concurrent refresh requests into one in-flight issuance', async () => {
    let releaseIssuance: ((token: EnterpriseLlmToken) => void) | undefined
    const state = harness()
    state.issue.mockImplementation(() => new Promise<EnterpriseLlmToken>(resolve => { releaseIssuance = resolve }))
    const first = state.refresher.refreshNow()
    const second = state.refresher.refreshNow()
    await flush()
    if (releaseIssuance === undefined) throw new Error('issuance was never started')
    releaseIssuance({ token: 'v1.once', expiresAt: 9_000_000, generation: 1 })
    await flush()
    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(true)
    expect(state.issue).toHaveBeenCalledTimes(1)
    expect(state.applied).toHaveLength(1)
    state.refresher.stop()
  })

  it('backs off exponentially on transient failures and resets after success', async () => {
    const state = harness({ retryDelayMs: 1_000, maxRetryDelayMs: 4_000 })
    let failures = 0
    state.issue.mockImplementation(async () => {
      if (failures < 3) {
        failures += 1
        throw new Error('gateway unreachable')
      }
      return { token: `v1.after-${String(failures)}`, expiresAt: 9_000_000, generation: failures }
    })
    state.refresher.start()
    await flush()
    expect(state.issue).toHaveBeenCalledTimes(1)
    // 1s -> 2s -> 4s of backoff across the three failures.
    await vi.advanceTimersByTimeAsync(1_000)
    await flush()
    expect(state.issue).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2_000)
    await flush()
    expect(state.issue).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(4_000)
    await flush()
    expect(state.issue).toHaveBeenCalledTimes(4)
    expect(state.applied).toHaveLength(1)
    expect(state.log.warn).toHaveBeenCalledTimes(3)
    // A failure after the success restarts the backoff from the base, not 8s:
    // the success token's half-life lands 4s out (expiresAt 9_000_000 from a
    // fixed logical now of 1_000_000), so advancing exactly there forces the
    // next issuance without spilling into the new backoff timer.
    failures = 2 // the next issuance fails once more
    await state.advance(4_000_000)
    await vi.advanceTimersByTimeAsync(4_000_000)
    await flush()
    expect(state.issue).toHaveBeenCalledTimes(5)
    await vi.advanceTimersByTimeAsync(1_000)
    await flush()
    expect(state.issue).toHaveBeenCalledTimes(6)
    expect(state.applied).toHaveLength(2)
    state.refresher.stop()
  })

  it('guides re-login on a 401 without rescheduling', async () => {
    const state = harness({
      failWith: () => new EnterpriseLlmTokenError('unauthorized', 'rejected'),
    })
    state.refresher.start()
    await flush()
    expect(state.onUnauthorized).toHaveBeenCalledTimes(1)
    expect(state.issue).toHaveBeenCalledTimes(1)
    expect(state.apply).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(600_000)
    await flush()
    expect(state.issue).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops silently on a missing llm scope and never treats it as transient', async () => {
    const state = harness({
      failWith: () => new EnterpriseLlmTokenError('insufficient_scope', 'needs llm scope'),
    })
    state.refresher.start()
    await flush()
    expect(state.log.error).toHaveBeenCalled()
    expect(state.onUnauthorized).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(600_000)
    await flush()
    expect(state.issue).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops cleanly: no further refreshes and an in-stop issue does not reschedule', async () => {
    let releaseIssuance: ((token: EnterpriseLlmToken) => void) | undefined
    const state = harness()
    state.issue.mockImplementation(() => new Promise<EnterpriseLlmToken>(resolve => { releaseIssuance = resolve }))
    state.refresher.start()
    await flush()
    state.refresher.stop()
    releaseIssuance?.({ token: 'v1.late', expiresAt: 9_000_000, generation: 1 })
    await flush()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(state.issue).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    await expect(state.refresher.refreshNow()).resolves.toBe(false)
    expect(state.issue).toHaveBeenCalledTimes(1)
  })

  it('does nothing when signed out (no access token available)', async () => {
    const state = harness({ signedOut: true })
    state.refresher.start()
    await flush()
    expect(state.issue).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clamps a very short remaining TTL to the minimum delay floor', async () => {
    const state = harness({ issued: () => ({ token: 'v1.short', expiresAt: 1_000_000 + 400, generation: 1 }) })
    state.refresher.start()
    await flush()
    expect(state.applied).toHaveLength(1)
    // half-life would be 200ms; the floor keeps it at 1s.
    await vi.advanceTimersByTimeAsync(999)
    await flush()
    expect(state.issue).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(state.issue).toHaveBeenCalledTimes(2)
    state.refresher.stop()
  })
})
