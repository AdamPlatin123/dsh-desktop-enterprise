import { afterEach, describe, expect, it } from 'vitest'
import {
  ENTERPRISE_UPDATE_URL_OVERRIDE,
  resolveEnterpriseUpdatePreset,
} from '../src/enterprise-update-preset.ts'

const OVERRIDE = process.env[ENTERPRISE_UPDATE_URL_OVERRIDE]

afterEach(() => {
  if (OVERRIDE === undefined) delete process.env[ENTERPRISE_UPDATE_URL_OVERRIDE]
  else process.env[ENTERPRISE_UPDATE_URL_OVERRIDE] = OVERRIDE
})

describe('enterprise update source preset', () => {
  it('resolves the fail-closed disabled default when nothing is preset', () => {
    delete process.env[ENTERPRISE_UPDATE_URL_OVERRIDE]
    expect(resolveEnterpriseUpdatePreset({})).toEqual({ status: 'disabled' })
    expect(resolveEnterpriseUpdatePreset({ [ENTERPRISE_UPDATE_URL_OVERRIDE]: '' }))
      .toEqual({ status: 'disabled' })
    expect(resolveEnterpriseUpdatePreset({ [ENTERPRISE_UPDATE_URL_OVERRIDE]: '   ' }))
      .toEqual({ status: 'disabled' })
  })

  it('resolves and canonicalizes a preset self-hosted origin', () => {
    expect(resolveEnterpriseUpdatePreset({ [ENTERPRISE_UPDATE_URL_OVERRIDE]: 'https://updates.corp.example' }))
      .toEqual({ status: 'ok', origin: 'https://updates.corp.example' })
    expect(resolveEnterpriseUpdatePreset({ [ENTERPRISE_UPDATE_URL_OVERRIDE]: 'http://updates.corp.example:8443/' }))
      .toEqual({ status: 'ok', origin: 'http://updates.corp.example:8443' })
  })

  it.each([
    ['not a url', 'the preset update source is not an absolute URL'],
    ['ftp://updates.corp.example', 'the preset update source must use http or https'],
    ['https://user:pass@updates.corp.example', 'the preset update source must not embed credentials'],
    ['https://updates.corp.example/?x=1', 'the preset update source must not carry a query or fragment'],
    ['https://updates.corp.example/#frag', 'the preset update source must not carry a query or fragment'],
    ['https://updates.corp.example/api', 'the preset update source must be an origin without a path'],
  ])('disables instead of accepting the invalid preset %s', (candidate, reason) => {
    expect(resolveEnterpriseUpdatePreset({ [ENTERPRISE_UPDATE_URL_OVERRIDE]: candidate }))
      .toEqual({ status: 'disabled', reason })
  })

  it('never resolves to the public upstream endpoint', () => {
    const resolved = resolveEnterpriseUpdatePreset({
      [ENTERPRISE_UPDATE_URL_OVERRIDE]: 'https://updates.corp.example',
    })
    if (resolved.status !== 'ok') throw new Error('preset should resolve')
    expect(resolved.origin).not.toContain('dshdesktop.cn')
  })
})
