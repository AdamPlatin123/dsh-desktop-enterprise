/** safeStorage-backed persistence for the enterprise OAuth token set. */

import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { DesktopLanHttpsPrivateKeyProtector } from './lan-https-certificate.ts'

const STATE_DIRECTORY_NAME = 'enterprise-auth'
const STATE_FILENAME = 'tokens.json'
const STATE_VERSION = 1
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const MAX_STATE_BYTES = 64 * 1024
const CHECK_POSIX_MODE = process.platform !== 'win32'
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u

export type EnterpriseTokenStoreErrorCode = 'storage-unavailable' | 'storage-state'

/** Stable, non-secret failure surfaced by the enterprise token store. */
export class EnterpriseTokenStoreError extends Error {
  readonly code: EnterpriseTokenStoreErrorCode

  constructor(code: EnterpriseTokenStoreErrorCode, message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'EnterpriseTokenStoreError'
    this.code = code
  }
}

export interface EnterpriseTokenProtectorSeed {
  readonly accessToken: string
  readonly refreshToken: string
  readonly scope: string
  readonly gatewayUrl: string
  readonly clientId: string
  readonly username?: string
  readonly expiresAt: number
  readonly refreshAt: number
  readonly obtainedAt: number
}

/** Decrypted-at-use token set; plaintext never touches the filesystem. */
export type EnterpriseTokenSet = EnterpriseTokenProtectorSeed

/** Epoch-ms schedule derived from the server `expires_in`. */
export function enterpriseTokenSchedule(expiresInSeconds: number, nowMs: number): {
  readonly expiresAt: number
  readonly refreshAt: number
} {
  if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds <= 0) {
    throw new TypeError('dsh-plugin-desktop: expires_in must be a positive safe integer')
  }
  return Object.freeze({
    expiresAt: nowMs + expiresInSeconds * 1000,
    // Refresh once half the lifetime is spent, so an in-flight refresh race
    // never surfaces an expired access token to consumers.
    refreshAt: nowMs + Math.floor(expiresInSeconds * 500),
  })
}

/** Validity projection used by the pre-Host gate and the refresher. */
export function enterpriseTokenValidity(
  tokens: EnterpriseTokenSet,
  nowMs: number,
): { readonly accessValid: boolean, readonly refreshable: boolean, readonly sessionUsable: boolean } {
  const accessValid = nowMs < tokens.expiresAt
  return Object.freeze({
    accessValid,
    // The refresh token is the session's last word: it stays usable until the
    // server rejects it. Rotation makes any local estimate stale, so the
    // store never locally expires a refresh token.
    refreshable: tokens.refreshToken.length > 0,
    sessionUsable: accessValid || tokens.refreshToken.length > 0,
  })
}

interface PersistedTokenStateV1 {
  readonly version: 1
  readonly sealed: string
}

interface StoredTokenPayload {
  readonly accessToken: string
  readonly refreshToken: string
  readonly scope: string
  readonly gatewayUrl: string
  readonly clientId: string
  readonly username?: string
  readonly expiresAt: number
  readonly refreshAt: number
  readonly obtainedAt: number
}

/** Exact tokens.json path below one Electron userData directory. */
export function enterpriseTokenStorePath(userDataDir: string): string {
  if (typeof userDataDir !== 'string' || userDataDir.length === 0
    || /[\0\r\n]/u.test(userDataDir) || !isAbsolute(userDataDir)) {
    throw new EnterpriseTokenStoreError(
      'storage-state',
      'enterprise token store userData must be an absolute path without control characters.',
    )
  }
  return join(resolve(userDataDir), STATE_DIRECTORY_NAME, STATE_FILENAME)
}

async function assertAvailableProtector(
  protector: DesktopLanHttpsPrivateKeyProtector,
): Promise<DesktopLanHttpsPrivateKeyProtector> {
  if (typeof protector.seal !== 'function' || typeof protector.open !== 'function') {
    throw new EnterpriseTokenStoreError('storage-unavailable', 'enterprise token protection is unavailable.')
  }
  try {
    const availability = typeof protector.available === 'function' ? await protector.available() : protector.available
    if (availability !== true) {
      throw new EnterpriseTokenStoreError('storage-unavailable', 'enterprise token protection is unavailable.')
    }
  } catch (cause) {
    if (cause instanceof EnterpriseTokenStoreError) throw cause
    throw new EnterpriseTokenStoreError('storage-unavailable', 'enterprise token protection is unavailable.', { cause })
  }
  return protector
}

async function prepareStateDirectory(userDataDir: string, stateDirectory: string): Promise<void> {
  const userDataInfo = await lstat(userDataDir)
  if (!userDataInfo.isDirectory() || userDataInfo.isSymbolicLink()) {
    throw new EnterpriseTokenStoreError('storage-state', 'enterprise token store userData must be an ordinary directory.')
  }
  try {
    await mkdir(stateDirectory, { mode: PRIVATE_DIRECTORY_MODE })
    await chmod(stateDirectory, PRIVATE_DIRECTORY_MODE)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new EnterpriseTokenStoreError('storage-state', 'enterprise token store directory is unavailable.', { cause })
    }
  }
  const stateInfo = await lstat(stateDirectory)
  if (!stateInfo.isDirectory() || stateInfo.isSymbolicLink()) {
    throw new EnterpriseTokenStoreError('storage-state', 'enterprise token store directory must be an ordinary directory.')
  }
  if (CHECK_POSIX_MODE && (stateInfo.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    await chmod(stateDirectory, PRIVATE_DIRECTORY_MODE)
  }
}

async function readStateFile(statePath: string): Promise<string | undefined> {
  let pathInfo: Awaited<ReturnType<typeof lstat>>
  try {
    pathInfo = await lstat(statePath)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new EnterpriseTokenStoreError('storage-state', 'enterprise token state could not be inspected.', { cause })
  }
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) {
    throw new EnterpriseTokenStoreError('storage-state', 'enterprise token state must be an ordinary file.')
  }
  if (pathInfo.size > MAX_STATE_BYTES) {
    throw new EnterpriseTokenStoreError('storage-state', `enterprise token state exceeds ${String(MAX_STATE_BYTES)} bytes.`)
  }
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(statePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (cause) {
    throw new EnterpriseTokenStoreError('storage-state', 'enterprise token state could not be opened safely.', { cause })
  }
  try {
    const openedInfo = await handle.stat()
    if (!openedInfo.isFile() || openedInfo.dev !== pathInfo.dev || openedInfo.ino !== pathInfo.ino) {
      throw new EnterpriseTokenStoreError('storage-state', 'enterprise token state changed while it was being opened.')
    }
    const bytes = Buffer.alloc(MAX_STATE_BYTES + 1)
    let offset = 0
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, null)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > MAX_STATE_BYTES) {
      throw new EnterpriseTokenStoreError('storage-state', `enterprise token state exceeds ${String(MAX_STATE_BYTES)} bytes.`)
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset))
    } catch (cause) {
      throw new EnterpriseTokenStoreError('storage-state', 'enterprise token state must contain valid UTF-8.', { cause })
    }
  } finally {
    await handle.close()
  }
}

function parsePersistedState(text: string): PersistedTokenStateV1 {
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch (cause) {
    throw new EnterpriseTokenStoreError('storage-state', 'enterprise token state must contain valid JSON.', { cause })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new EnterpriseTokenStoreError('storage-state', 'enterprise token state root must be an object.')
  }
  const object = value as Record<string, unknown>
  const keys = Object.keys(object).sort()
  if (keys.length !== 2 || keys[0] !== 'sealed' || keys[1] !== 'version') {
    throw new EnterpriseTokenStoreError('storage-state', 'enterprise token state contains unexpected fields.')
  }
  if (object.version !== STATE_VERSION) {
    throw new EnterpriseTokenStoreError('storage-state', 'enterprise token state has an unsupported version.')
  }
  if (typeof object.sealed !== 'string' || !isCanonicalBase64(object.sealed)) {
    throw new EnterpriseTokenStoreError('storage-state', 'enterprise token sealed blob must be canonical base64.')
  }
  return Object.freeze({ version: STATE_VERSION, sealed: object.sealed })
}

function parseTokenPayload(plaintext: string): EnterpriseTokenSet {
  let value: unknown
  try {
    value = JSON.parse(plaintext) as unknown
  } catch (cause) {
    throw new EnterpriseTokenStoreError('storage-state', 'sealed enterprise token payload is not valid JSON.', { cause })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new EnterpriseTokenStoreError('storage-state', 'sealed enterprise token payload must be an object.')
  }
  const object = value as Record<string, unknown>
  const strings = ['accessToken', 'refreshToken', 'scope', 'gatewayUrl', 'clientId'] as const
  for (const key of strings) {
    if (typeof object[key] !== 'string' || (object[key] as string).length === 0) {
      throw new EnterpriseTokenStoreError('storage-state', `sealed enterprise token payload field ${key} is missing.`)
    }
  }
  for (const key of ['expiresAt', 'refreshAt', 'obtainedAt'] as const) {
    if (typeof object[key] !== 'number' || !Number.isSafeInteger(object[key])) {
      throw new EnterpriseTokenStoreError('storage-state', `sealed enterprise token payload field ${key} is invalid.`)
    }
  }
  const username = object.username
  if (username !== undefined && (typeof username !== 'string' || username.length === 0 || username.length > 256)) {
    throw new EnterpriseTokenStoreError('storage-state', 'sealed enterprise token payload field username is invalid.')
  }
  return Object.freeze({
    accessToken: object.accessToken as string,
    refreshToken: object.refreshToken as string,
    scope: object.scope as string,
    gatewayUrl: object.gatewayUrl as string,
    clientId: object.clientId as string,
    expiresAt: object.expiresAt as number,
    refreshAt: object.refreshAt as number,
    obtainedAt: object.obtainedAt as number,
    ...(typeof username === 'string' ? { username } : {}),
  })
}

function isCanonicalBase64(value: string): boolean {
  if (value.length === 0 || value.length > MAX_STATE_BYTES || value.length % 4 !== 0
    || !BASE64_PATTERN.test(value)) return false
  return Buffer.from(value, 'base64').toString('base64') === value
}

/**
 * Read the stored token set; absence returns undefined. A sealed blob the
 * protector can no longer open (e.g. an OS keyring migration) surfaces as
 * `storage-unavailable` so the gate can send the user through re-login
 * without silently treating the session as absent.
 */
export async function readEnterpriseTokens(
  userDataDir: string,
  protector: DesktopLanHttpsPrivateKeyProtector,
): Promise<EnterpriseTokenSet | undefined> {
  const usable = await assertAvailableProtector(protector)
  const statePath = enterpriseTokenStorePath(userDataDir)
  const stateText = await readStateFile(statePath)
  if (stateText === undefined) return undefined
  const state = parsePersistedState(stateText)
  const sealed = Buffer.from(state.sealed, 'base64')
  let opened: Buffer
  try {
    const output = await usable.open(sealed)
    if (!(output instanceof Uint8Array) || output.byteLength === 0 || output.byteLength > MAX_STATE_BYTES) {
      throw new TypeError('protector returned invalid plaintext')
    }
    opened = Buffer.from(output)
  } catch (cause) {
    throw new EnterpriseTokenStoreError('storage-unavailable', 'sealed enterprise tokens could not be opened.', { cause })
  } finally {
    sealed.fill(0)
  }
  try {
    const plaintext = new TextDecoder('utf-8', { fatal: true }).decode(opened)
    return parseTokenPayload(plaintext)
  } catch (cause) {
    if (cause instanceof EnterpriseTokenStoreError) throw cause
    throw new EnterpriseTokenStoreError('storage-state', 'sealed enterprise token payload is not valid UTF-8.', { cause })
  } finally {
    opened.fill(0)
  }
}

/** Atomically persist the token set under the OS-backed protector. */
export async function saveEnterpriseTokens(
  userDataDir: string,
  protector: DesktopLanHttpsPrivateKeyProtector,
  tokens: EnterpriseTokenSet,
): Promise<void> {
  const usable = await assertAvailableProtector(protector)
  const statePath = enterpriseTokenStorePath(userDataDir)
  const payload: StoredTokenPayload = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    scope: tokens.scope,
    gatewayUrl: tokens.gatewayUrl,
    clientId: tokens.clientId,
    expiresAt: tokens.expiresAt,
    refreshAt: tokens.refreshAt,
    obtainedAt: tokens.obtainedAt,
    ...(tokens.username === undefined ? {} : { username: tokens.username }),
  }
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8')
  let sealed: Buffer
  try {
    const output = await usable.seal(plaintext)
    if (!(output instanceof Uint8Array) || output.byteLength === 0 || output.byteLength > MAX_STATE_BYTES) {
      throw new TypeError('protector returned invalid sealed bytes')
    }
    sealed = Buffer.from(output)
    if (sealed.equals(plaintext) || sealed.includes(Buffer.from(tokens.accessToken, 'utf8'))) {
      throw new TypeError('protector did not conceal the token set')
    }
  } catch (cause) {
    throw new EnterpriseTokenStoreError('storage-unavailable', 'enterprise tokens could not be sealed.', { cause })
  } finally {
    plaintext.fill(0)
  }
  try {
    await prepareStateDirectory(userDataDir, join(resolve(userDataDir), STATE_DIRECTORY_NAME))
    const state: PersistedTokenStateV1 = Object.freeze({ version: STATE_VERSION, sealed: sealed.toString('base64') })
    const write = withFileLock(statePath, async () => {
      await writeFileAtomic(statePath, `${JSON.stringify(state, undefined, 2)}\n`, {
        mode: PRIVATE_FILE_MODE,
        dirMode: PRIVATE_DIRECTORY_MODE,
      })
      if (CHECK_POSIX_MODE) await chmod(statePath, PRIVATE_FILE_MODE)
    })
    await write
  } catch (cause) {
    if (cause instanceof EnterpriseTokenStoreError) throw cause
    throw new EnterpriseTokenStoreError('storage-state', 'enterprise token state could not be persisted safely.', { cause })
  } finally {
    sealed.fill(0)
  }
}

/** Remove the stored token set (used when a Profile is deleted or on explicit sign-out). */
export async function clearEnterpriseTokens(userDataDir: string): Promise<void> {
  const statePath = enterpriseTokenStorePath(userDataDir)
  try {
    await rm(statePath, { force: true })
  } catch (cause) {
    throw new EnterpriseTokenStoreError('storage-state', 'enterprise token state could not be removed.', { cause })
  }
}

export const enterpriseTokenStoreConstants = Object.freeze({
  stateDirectoryName: STATE_DIRECTORY_NAME,
  stateFilename: STATE_FILENAME,
  stateVersion: STATE_VERSION,
  directoryMode: PRIVATE_DIRECTORY_MODE,
  fileMode: PRIVATE_FILE_MODE,
  maxStateBytes: MAX_STATE_BYTES,
})
