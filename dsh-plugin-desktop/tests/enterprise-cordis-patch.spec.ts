import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ENTERPRISE_LLM_API_KEY_ENV,
  ENTERPRISE_LLM_EGRESS_PATH,
  ENTERPRISE_LLM_ROUTE,
  ENTERPRISE_MACHINE_PATCH_MARKER,
  renderEnterpriseMachinePatch,
  writeEnterpriseMachinePatch,
} from '../src/enterprise-cordis-patch.ts'

describe('enterprise machine patch rendering', () => {
  it('locks the llm route to the gateway llm-egress and the DSH_LLM_TOKEN credential', () => {
    const document = renderEnterpriseMachinePatch({ gatewayUrl: 'https://gateway.example.com/' })
    expect(document).toContain(`# ${ENTERPRISE_MACHINE_PATCH_MARKER}.`)
    expect(document).toContain('- id: llm-pi-ai')
    expect(document).toContain(`providers:`)
    expect(document).toContain(`      ${ENTERPRISE_LLM_ROUTE}:`)
    expect(document).toContain(`apiKeyEnv: ${ENTERPRISE_LLM_API_KEY_ENV}`)
    expect(document).toContain('api: openai-completions')
    expect(document).toContain(`baseURL: "https://gateway.example.com${ENTERPRISE_LLM_EGRESS_PATH}"`)
    expect(document).toContain('- id: "deepseek-chat"')
    expect(document).toContain('- id: "deepseek-reasoner"')
  })

  it('accepts a deployment-specific model allowlist', () => {
    const document = renderEnterpriseMachinePatch({
      gatewayUrl: 'https://gateway.example.com',
      models: [{ id: 'deepseek-v3', name: 'DeepSeek V3' }],
    })
    expect(document).toContain('- id: "deepseek-v3"')
    expect(document).toContain('name: "DeepSeek V3"')
    expect(document).not.toContain('deepseek-reasoner')
  })
})

describe('enterprise machine patch installation', () => {
  async function tempHome(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'dsh-enterprise-patch-'))
  }

  it('writes, then keeps the document unchanged on repeat runs', async () => {
    const home = await tempHome()
    try {
      const document = renderEnterpriseMachinePatch({ gatewayUrl: 'https://gateway.example.com' })
      expect(await writeEnterpriseMachinePatch(home, document)).toEqual({ status: 'written' })
      expect(await readFile(join(home, 'cordis.patch.yml'), 'utf8')).toBe(document)
      expect(await writeEnterpriseMachinePatch(home, document)).toEqual({ status: 'unchanged' })
      const updated = renderEnterpriseMachinePatch({ gatewayUrl: 'https://gateway2.example.com' })
      expect(await writeEnterpriseMachinePatch(home, updated)).toEqual({ status: 'updated' })
      expect(await readFile(join(home, 'cordis.patch.yml'), 'utf8')).toBe(updated)
    } finally {
      await rmHome(home)
    }
  })

  it('never overwrites an admin-authored patch document', async () => {
    const home = await tempHome()
    try {
      const adminDocument = '# my own routing rules\n- id: custom\n'
      await writeFile(join(home, 'cordis.patch.yml'), adminDocument, { encoding: 'utf8' })
      const document = renderEnterpriseMachinePatch({ gatewayUrl: 'https://gateway.example.com' })
      expect(await writeEnterpriseMachinePatch(home, document)).toEqual({ status: 'admin-file-kept' })
      expect(await readFile(join(home, 'cordis.patch.yml'), 'utf8')).toBe(adminDocument)
    } finally {
      await rmHome(home)
    }
  })
})

async function rmHome(home: string): Promise<void> {
  await rm(home, { recursive: true, force: true })
}
