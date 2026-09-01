import { describe, expect, it } from 'vitest'
import {
  ENTERPRISE_OAUTH_SCOPE,
  resolveEnterpriseGatewayPreset,
  resolveEnterpriseTelemetryPolicy,
  validateEnterpriseGatewayUrl,
} from '../src/enterprise-gateway-preset.ts'

describe('enterprise gateway preset', () => {
  it('reports missing when neither the build define nor an override is present', () => {
    expect(resolveEnterpriseGatewayPreset({})).toEqual({ status: 'missing' })
    expect(resolveEnterpriseGatewayPreset({ DSH_ENTERPRISE_GATEWAY_URL: '', DSH_ENTERPRISE_OAUTH_CLIENT_ID: '' }))
      .toEqual({ status: 'missing' })
  })

  it('resolves an ok preset from the override channels and canonicalizes the origin', () => {
    const preset = resolveEnterpriseGatewayPreset({
      DSH_ENTERPRISE_GATEWAY_URL: 'https://gateway.example.com/',
      DSH_ENTERPRISE_OAUTH_CLIENT_ID: ' dsh-desktop ',
    })
    expect(preset).toEqual({ status: 'ok', gatewayUrl: 'https://gateway.example.com', clientId: 'dsh-desktop' })
  })

  it('rejects half-present presets so a partial deployment fails loudly', () => {
    expect(resolveEnterpriseGatewayPreset({ DSH_ENTERPRISE_GATEWAY_URL: 'https://g.example' }))
      .toEqual({ status: 'invalid', detail: expect.stringContaining('client id') })
    expect(resolveEnterpriseGatewayPreset({ DSH_ENTERPRISE_OAUTH_CLIENT_ID: 'dsh-desktop' }))
      .toEqual({ status: 'invalid', detail: expect.stringContaining('gateway URL') })
  })

  it('rejects invalid gateway URLs with a stable detail', () => {
    const invalid = resolveEnterpriseGatewayPreset({
      DSH_ENTERPRISE_GATEWAY_URL: 'not a url',
      DSH_ENTERPRISE_OAUTH_CLIENT_ID: 'dsh-desktop',
    })
    expect(invalid.status).toBe('invalid')

    for (const url of [
      'ftp://gateway.example.com',
      'https://user:pass@gateway.example.com',
      'https://gateway.example.com/path?q=1',
      'https://gateway.example.com/#frag',
    ]) {
      expect(() => validateEnterpriseGatewayUrl(url)).toThrow(TypeError)
    }
    expect(validateEnterpriseGatewayUrl('http://127.0.0.1:8321')).toBe('http://127.0.0.1:8321')
  })

  it('keeps the enterprise OAuth scope stable for the server contract', () => {
    expect(ENTERPRISE_OAUTH_SCOPE).toBe('openid session llm')
  })
})

describe('enterprise telemetry policy preset', () => {
  it('is off unless the deployment explicitly presets on', () => {
    // Compliance default: absent define and absent override stay closed.
    expect(resolveEnterpriseTelemetryPolicy({})).toBe('off')
    expect(resolveEnterpriseTelemetryPolicy({ DSH_ENTERPRISE_TELEMETRY: '' })).toBe('off')
    expect(resolveEnterpriseTelemetryPolicy({ DSH_ENTERPRISE_TELEMETRY: 'on' })).toBe('on')
  })

  it('accepts the exact value case-insensitively and rejects everything else', () => {
    expect(resolveEnterpriseTelemetryPolicy({ DSH_ENTERPRISE_TELEMETRY: ' ON ' })).toBe('on')
    for (const candidate of ['true', '1', 'yes', 'On, plus extras', 'off']) {
      expect(resolveEnterpriseTelemetryPolicy({ DSH_ENTERPRISE_TELEMETRY: candidate })).toBe('off')
    }
  })
})
