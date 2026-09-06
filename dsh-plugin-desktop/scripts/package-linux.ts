/** Build an unsigned Linux x64 unpacked application on a native Linux host. */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Injectable Linux packaging boundary used by focused tests. */
export interface LinuxPackageOptions {
  /** Environment inherited by the packaging command. */
  readonly env: NodeJS.ProcessEnv
  /** Platform executing the package build. */
  readonly platform: NodeJS.Platform
  /** Node architecture executing the package build. */
  readonly arch: string
  /** Desktop package root containing electron-builder configuration. */
  readonly desktopRoot: string
  /** Absolute electron-builder CLI module. */
  readonly builderCli: string
  /** Node executable used to run package-local scripts. */
  readonly nodeExecutable: string
  /** Execute one packaging command. */
  readonly run: (
    command: string,
    args: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ) => void
  /** Report non-secret packaging progress. */
  readonly log: (message: string) => void
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): void {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
  }
}

/** Create the native packaging options for a Linux entry point. */
export function createLinuxPackageOptions(): LinuxPackageOptions {
  const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const require = createRequire(import.meta.url)
  return {
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    desktopRoot,
    builderCli: require.resolve('electron-builder/cli.js'),
    nodeExecutable: process.execPath,
    run,
    log: message => console.log(message),
  }
}

/**
 * Package one unsigned Linux x64 unpacked application.
 *
 * The `dir` target keeps the artifact runnable for smoke testing on the build
 * host; distribution formats such as AppImage or deb stay a downstream choice
 * because they need host-specific tooling.
 * @param options - Injectable process and command boundaries.
 */
export function packageLinuxArtifact(
  options: LinuxPackageOptions = createLinuxPackageOptions(),
): void {
  if (options.platform !== 'linux') {
    throw new Error(`Linux packages must be built on a native Linux host; received ${options.platform}`)
  }
  if (options.arch !== 'x64' && options.arch !== 'arm64') {
    throw new Error(`Linux packages require x64 or arm64 Node; received ${options.arch}`)
  }
  options.log('Building an unsigned Linux unpacked application; distribution packaging is a downstream step.')
  options.run(
    options.nodeExecutable,
    [
      options.builderCli,
      '--linux',
      'dir',
      `--${options.arch}`,
      '--publish',
      'never',
      '--config.npmRebuild=false',
    ],
    options.desktopRoot,
    {
      ...options.env,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    },
  )
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    packageLinuxArtifact()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
