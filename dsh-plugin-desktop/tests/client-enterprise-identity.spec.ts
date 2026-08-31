import { describe, expect, it } from 'vitest'
import { detectEnterpriseSessionRejection } from '../src/client/enterprise-session-banner.ts'
import {
  parseDesktopEnterpriseIdentityView,
} from '../src/client/desktop-settings-api.ts'

describe('renderer-side enterprise identity parsing', () => {
  it('accepts an exact identity projection', () => {
    expect(parseDesktopEnterpriseIdentityView({ username: 'alice', role: 'admin' }))
      .toEqual({ username: 'alice', role: 'admin' })
    expect(parseDesktopEnterpriseIdentityView({ username: 'bob', role: 'member' }))
      .toEqual({ username: 'bob', role: 'member' })
  })

  it('rejects shapes the account area must never render', () => {
    for (const value of [
      null,
      undefined,
      'alice',
      [],
      {},
      { username: '', role: 'member' },
      { username: 'alice' },
      { username: 'alice', role: '' },
      { username: 'alice', role: '1leading-digit' },
      { username: 'alice', role: 'has space' },
      { username: `${'x'.repeat(257)}`, role: 'member' },
      { username: 'alice', role: `${'x'.repeat(65)}` },
    ]) {
      expect(() => parseDesktopEnterpriseIdentityView(value)).toThrow()
    }
  })
})

describe('enterprise session-error detection', () => {
  it('matches the llm-egress 401 rejections inside session error text', () => {
    expect(detectEnterpriseSessionRejection('LLM request failed: 401: {"error":"invalid_token"}')).toBe(true)
    expect(detectEnterpriseSessionRejection('401 {"error":"token_revoked"}')).toBe(true)
    expect(detectEnterpriseSessionRejection('prefix 401 — invalid_token suffix')).toBe(true)
  })

  it('ignores unrelated model and network errors', () => {
    expect(detectEnterpriseSessionRejection('429: rate limited')).toBe(false)
    expect(detectEnterpriseSessionRejection('500: internal gateway error')).toBe(false)
    expect(detectEnterpriseSessionRejection('401: {"error":"invalid_request"}')).toBe(false)
    expect(detectEnterpriseSessionRejection('connect ECONNREFUSED')).toBe(false)
    expect(detectEnterpriseSessionRejection('')).toBe(false)
  })

  it('never scans unbounded error text', () => {
    const huge = `401 ${'x'.repeat(10_000)} invalid_token`
    expect(detectEnterpriseSessionRejection(huge)).toBe(false)
  })
})
