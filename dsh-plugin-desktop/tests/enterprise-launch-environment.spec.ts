import { describe, expect, it, vi } from 'vitest'
import type { LaunchEnvironmentEntry, LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { createDesktopEnterpriseLaunchEnvironment } from '../src/enterprise-launch-environment.ts'

function entry(value: string, source: LaunchEnvironmentEntry['source']): LaunchEnvironmentEntry {
  return Object.freeze({ value, source })
}

/** A plain wrapped snapshot backed by two maps, standing in for the boot snapshot. */
function wrappedSnapshot(
  process: ReadonlyMap<string, string> = new Map(),
  projectEnv: ReadonlyMap<string, string> = new Map(),
): LaunchEnvironmentSnapshot {
  const getFrom = (name: string, sources: readonly LaunchEnvironmentEntry['source'][]): LaunchEnvironmentEntry | undefined => {
    if (sources.includes('process')) {
      const value = process.get(name)
      if (value !== undefined) return entry(value, 'process')
    }
    if (sources.includes('project-env')) {
      const value = projectEnv.get(name)
      if (value !== undefined) return entry(value, 'project-env')
    }
    return undefined
  }
  return {
    get: name => getFrom(name, ['process', 'project-env', 'user-env']),
    getFrom,
  }
}

describe('desktop enterprise launch environment', () => {
  it('serves a process-layer override ahead of the wrapped snapshot', () => {
    const environment = createDesktopEnterpriseLaunchEnvironment(wrappedSnapshot(new Map([['DSH_LLM_TOKEN', 'stale']])))
    environment.set('DSH_LLM_TOKEN', 'fresh')
    expect(environment.snapshot.get('DSH_LLM_TOKEN')).toEqual(entry('fresh', 'process'))
    expect(environment.has('DSH_LLM_TOKEN')).toBe(true)
  })

  it('returns an override only when the caller asks for the process layer', () => {
    const environment = createDesktopEnterpriseLaunchEnvironment(wrappedSnapshot())
    environment.set('DSH_LLM_TOKEN', 'fresh')
    expect(environment.snapshot.getFrom('DSH_LLM_TOKEN', ['process'])).toEqual(entry('fresh', 'process'))
    expect(environment.snapshot.getFrom('DSH_LLM_TOKEN', ['project-env'])).toBeUndefined()
    expect(environment.snapshot.getFrom('DSH_LLM_TOKEN', ['user-env'])).toBeUndefined()
  })

  it('delegates to the wrapped snapshot when no override exists', () => {
    const wrapped = wrappedSnapshot(
      new Map([['EXISTING', 'from-process']]),
      new Map([['PROJECT', 'from-project']]),
    )
    const getFromSpy = vi.spyOn(wrapped, 'getFrom')
    const environment = createDesktopEnterpriseLaunchEnvironment(wrapped)
    expect(environment.snapshot.get('EXISTING')).toEqual(entry('from-process', 'process'))
    expect(environment.snapshot.get('PROJECT')).toEqual(entry('from-project', 'project-env'))
    expect(environment.snapshot.get('MISSING')).toBeUndefined()
    expect(environment.has('EXISTING')).toBe(false)
    expect(getFromSpy).toHaveBeenCalled()
  })

  it('hot-reloads: a set shadows the wrapped value and a delete reveals it again', () => {
    const environment = createDesktopEnterpriseLaunchEnvironment(wrappedSnapshot(new Map([['DSH_LLM_TOKEN', 'generation-1']])))
    expect(environment.snapshot.get('DSH_LLM_TOKEN')?.value).toBe('generation-1')
    environment.set('DSH_LLM_TOKEN', 'generation-2')
    expect(environment.snapshot.get('DSH_LLM_TOKEN')?.value).toBe('generation-2')
    environment.delete('DSH_LLM_TOKEN')
    expect(environment.snapshot.get('DSH_LLM_TOKEN')?.value).toBe('generation-1')
    expect(environment.has('DSH_LLM_TOKEN')).toBe(false)
    expect(() => environment.delete('NEVER_SET')).not.toThrow()
  })

  it('never lets an override masquerade as project configuration layers', () => {
    const environment = createDesktopEnterpriseLaunchEnvironment(wrappedSnapshot(new Map(), new Map([['KEY', 'project']])))
    environment.set('KEY', 'override')
    expect(environment.snapshot.getFrom('KEY', ['project-env', 'user-env'])).toEqual(entry('project', 'project-env'))
    expect(environment.snapshot.getFrom('KEY', ['process', 'project-env', 'user-env'])?.value).toBe('override')
  })
})
