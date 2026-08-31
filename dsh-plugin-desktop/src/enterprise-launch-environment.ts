/**
 * Runtime-mutable launch environment for the enterprise token chain.
 *
 * The upstream launch environment is an immutable boot-time snapshot, and the
 * Host resolves `apiKeyEnv` credentials through it per operation. That per-call
 * read is the hot-reload seam: the desktop launcher provides this wrapper in
 * place of the plain snapshot, and a refreshed LLM token written into the
 * override layer reaches the very next model request without a restart.
 *
 * Overrides shadow the `process` layer only. The `.env` layers of the wrapped
 * snapshot stay exactly as the launcher resolved them, so a value written here
 * can never masquerade as project or user configuration.
 */

import type { LaunchEnvironmentEntry, LaunchEnvironmentSnapshot, LaunchEnvironmentSource } from '@deepseek-ai/dsh-launch-environment'

export interface DesktopEnterpriseLaunchEnvironment {
  /** The snapshot to provide to the Host as `DSH_LAUNCH_ENVIRONMENT_KEY`. */
  readonly snapshot: LaunchEnvironmentSnapshot
  /** Add or replace one `process`-layer override. */
  set(name: string, value: string): void
  /** Remove one override; deleting an absent name is a no-op. */
  delete(name: string): void
  /** Whether an override currently exists (tests and sign-out hygiene). */
  has(name: string): boolean
}

export function createDesktopEnterpriseLaunchEnvironment(
  wrapped: LaunchEnvironmentSnapshot,
): DesktopEnterpriseLaunchEnvironment {
  const overrides = new Map<string, LaunchEnvironmentEntry>()
  const getFrom = (name: string, sources: readonly LaunchEnvironmentSource[]): LaunchEnvironmentEntry | undefined => {
    if (sources.includes('process')) {
      const override = overrides.get(name)
      if (override !== undefined) return override
    }
    return wrapped.getFrom(name, sources)
  }
  return Object.freeze({
    snapshot: Object.freeze({
      get: (name: string): LaunchEnvironmentEntry | undefined => getFrom(name, ['process', 'project-env', 'user-env']),
      getFrom: (name: string, sources: readonly LaunchEnvironmentSource[]): LaunchEnvironmentEntry | undefined => getFrom(name, sources),
    }),
    set: (name: string, value: string): void => { overrides.set(name, Object.freeze({ value, source: 'process' })) },
    delete: (name: string): void => { overrides.delete(name) },
    has: (name: string): boolean => overrides.has(name),
  })
}
