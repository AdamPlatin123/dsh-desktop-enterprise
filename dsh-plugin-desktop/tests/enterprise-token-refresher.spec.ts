import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EnterpriseTokenRefresher } from '../src/enterprise-token-refresher.ts'
import type { EnterpriseTokenSet } from '../src/enterprise-token-store.ts'

function tokensAt(now: number, expiresInSeconds: number): EnterpriseTokenSet {
  return {
    accessToken: `access-${String(now)}`,
    refreshToken: 'refresh-1',
    scope: 'openid session llm',
    gatewayUrl: 'https://gateway.example.com',
    clientId: 'dsh-desktop',
    expiresAt: now + expiresInSeconds * 1000,
    refreshAt: now + expiresInSeconds * 500,
    obtainedAt: now,
  }
}

interface HarnessOptions {
  readonly expiresInSeconds?: number
}

function harness({ expiresInSeconds = 600 }: HarnessOptions = {}) {
  let current: EnterpriseTokenSet | undefined = tokensAt(1_000_000, expiresInSeconds)
  const calls: string[] = []
  const refresher = new EnterpriseTokenRefresher({
    gatewayUrl: 'https://gateway.example.com',
    clientId: 'dsh-desktop',
    transport: async () => {
      calls.push('transport')
      return {
        status: 200,
        text: JSON.stringify({ access_token: 'access-next', refresh_token: 'refresh-2', expires_in: 600, token_type: 'Bearer' }),
      }
    },
    read: async () => {
      calls.push('read')
      return current
    },
    save: async tokens => {
      calls.push('save')
      current = tokens
    },
    now: () => 1_000_000,
    minDelayMs: 0,
    onRefreshFailed: cause => { calls.push(`failed:${String(cause instanceof Error ? cause.message : cause)}`) },
    onRefreshed: () => { calls.push('refreshed') },
  })
  return { refresher, calls, readCurrent: () => current }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('enterprise token refresher', () => {
  it('rotates at the stored half-life and persists the rotated set', async () => {
    const { refresher, calls, readCurrent } = harness({ expiresInSeconds: 600 })
    refresher.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.filter(call => call === 'read')).toHaveLength(1)
    // refreshAt is now+300s; nothing before that point.
    await vi.advanceTimersByTimeAsync(299_999)
    expect(calls).not.toContain('transport')
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => { expect(calls).toContain('save') })
    expect(readCurrent()?.accessToken).toBe('access-next')
    expect(readCurrent()?.refreshToken).toBe('refresh-2')
    expect(calls).toContain('refreshed')
    refresher.stop()
  })

  it('reschedules the next rotation from the rotated half-life', async () => {
    const { refresher, calls } = harness({ expiresInSeconds: 600 })
    refresher.start()
    await vi.advanceTimersByTimeAsync(300_000)
    await vi.waitFor(() => { expect(calls.filter(call => call === 'transport')).toHaveLength(1) })
    // The rotated set refreshes another half-life later, not immediately.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(calls.filter(call => call === 'transport')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(300_000)
    await vi.waitFor(() => { expect(calls.filter(call => call === 'transport')).toHaveLength(2) })
    refresher.stop()
  })

  it('keeps the stored session and reports failure when the grant is rejected', async () => {
    const { calls, readCurrent } = harness()
    const failing = new EnterpriseTokenRefresher({
      gatewayUrl: 'https://gateway.example.com',
      clientId: 'dsh-desktop',
      transport: async () => { throw Object.assign(new Error('denied'), { code: 'invalid_grant' }) },
      read: async () => tokensAt(1_000_000, 600),
      save: async () => { calls.push('save') },
      now: () => 1_000_000,
      onRefreshFailed: () => { calls.push('failed') },
    })
    await expect(failing.refreshNow()).resolves.toBe(false)
    expect(calls).toEqual(['failed'])
    // save was never invoked: the stored set survives the failed refresh.
    expect(readCurrent()?.accessToken).toContain('access-')
  })

  it('merges concurrent forced refreshes into a single transport call', async () => {
    const { refresher, calls } = harness()
    refresher.stop()
    const pending = new EnterpriseTokenRefresher({
      gatewayUrl: 'https://gateway.example.com',
      clientId: 'dsh-desktop',
      transport: async () => {
        await new Promise(resolve => { setTimeout(resolve, 1000) })
        return {
          status: 200,
          text: JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 600, token_type: 'Bearer' }),
        }
      },
      read: async () => tokensAt(1_000_000, 600),
      save: async () => { calls.push('save') },
      now: () => 1_000_000,
      onRefreshFailed: () => { calls.push('failed') },
    })
    const first = pending.refreshNow()
    const second = pending.refreshNow()
    expect(first).toBe(second)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await first).toBe(true)
    expect(calls.filter(call => call === 'save')).toHaveLength(1)
  })

  it('ignores token sets that belong to a different gateway', async () => {
    let current: EnterpriseTokenSet | undefined = { ...tokensAt(1_000_000, 600), gatewayUrl: 'https://other.example.com' }
    const calls: string[] = []
    const refresher = new EnterpriseTokenRefresher({
      gatewayUrl: 'https://gateway.example.com',
      clientId: 'dsh-desktop',
      transport: async () => {
        calls.push('transport')
        return { status: 200, text: JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 600, token_type: 'Bearer' }) }
      },
      read: async () => current,
      save: async tokens => { current = tokens },
      now: () => 1_000_000,
      onRefreshFailed: () => { calls.push('failed') },
    })
    await expect(refresher.refreshNow()).resolves.toBe(false)
    expect(calls).toEqual([])
    refresher.stop()
  })
})
