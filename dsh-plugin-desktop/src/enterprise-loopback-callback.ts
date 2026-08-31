/** RFC 8252 loopback redirect receiver for the enterprise OAuth flow. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { isIPv4 } from 'node:net'

const CALLBACK_PATH = '/cb'
const MAX_URL_BYTES = 2048
/** Brief R14 window: the login attempt fails into the timeout state after this long. */
export const ENTERPRISE_LOGIN_TIMEOUT_MS = 5 * 60 * 1000
/** Fixed loopback redirect path presented to the authorization server. */

export type EnterpriseLoopbackCallback =
  | { readonly kind: 'success', readonly code: string, readonly state: string }
  | { readonly kind: 'error', readonly error: string, readonly errorDescription?: string, readonly state?: string }
  | { readonly kind: 'malformed' }

export type EnterpriseLoopbackErrorCode = 'bind-failed' | 'timeout' | 'disposed'

export class EnterpriseLoopbackError extends Error {
  readonly code: EnterpriseLoopbackErrorCode

  constructor(code: EnterpriseLoopbackErrorCode, message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'EnterpriseLoopbackError'
    this.code = code
  }
}

export interface EnterpriseLoopbackListenerOptions {
  /**
   * Candidate ports tried in order; the default `[0]` lets the OS pick a free
   * port, which the server's `http://127.0.0.1:*` client pattern accepts.
   * Tests pin candidate ports to exercise the occupancy fallback.
   */
  readonly ports?: readonly number[]
  readonly timeoutMs?: number
}

function completionPage(kind: 'done' | 'denied' | 'invalid'): string {
  const title = kind === 'done'
    ? '登录完成 / Sign-in complete'
    : kind === 'denied'
      ? '授权被拒绝 / Authorization denied'
      : '无效的回跳 / Invalid redirect'
  const body = kind === 'done'
    ? '请返回 DSH Desktop 应用，登录已在桌面端继续。You can return to the DSH Desktop app; sign-in continues there.'
    : kind === 'denied'
      ? '你在浏览器中拒绝了授权。请返回 DSH Desktop 应用后重试。You denied the authorization request; return to the DSH Desktop app to retry.'
      : '此回跳无法被识别。请从 DSH Desktop 应用重新发起登录。The redirect could not be understood; start sign-in from the DSH Desktop app again.'
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#202124}h1{font-size:1.25rem}</style>
</head>
<body><h1>${title}</h1><p>${body}</p></body>
</html>
`
}

function sendPage(res: ServerResponse, status: number, page: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(page)
}

function parseCallbackTarget(rawUrl: string): EnterpriseLoopbackCallback {
  const url = new URL(rawUrl)
  if (url.pathname !== CALLBACK_PATH || url.search === '') return { kind: 'malformed' }
  const state = url.searchParams.get('state')
  const error = url.searchParams.get('error')
  if (error !== null) {
    if (error.length === 0 || error.length > 128) return { kind: 'malformed' }
    const errorDescription = url.searchParams.get('error_description')
    return {
      kind: 'error',
      error,
      ...(errorDescription !== null && errorDescription.length > 0 && errorDescription.length <= 512
        ? { errorDescription }
        : {}),
      ...(state !== null && state.length > 0 && state.length <= 512 ? { state } : {}),
    }
  }
  const code = url.searchParams.get('code')
  if (code === null || code.length === 0 || code.length > 2048) return { kind: 'malformed' }
  if (state === null || state.length === 0 || state.length > 512) return { kind: 'malformed' }
  return { kind: 'success', code, state }
}

function isLoopbackHostHeader(host: string | undefined, port: number): boolean {
  if (host === undefined) return false
  const separator = host.lastIndexOf(':')
  if (separator < 0) return false
  const hostname = host.slice(0, separator)
  const hostPort = Number(host.slice(separator + 1))
  if (hostPort !== port) return false
  if (isIPv4(hostname)) return hostname === '127.0.0.1'
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, '')
  return normalized === '::1' || normalized === 'localhost'
}

/**
 * One-shot loopback HTTP listener that captures exactly one OAuth redirect.
 * The listener is bound to 127.0.0.1 only, rejects non-loopback Host headers
 * (DNS-rebinding hardening), and shuts down after the terminal callback.
 */
export class EnterpriseLoopbackListener {
  private server: Server | undefined
  private timeoutTimer: ReturnType<typeof setTimeout> | undefined
  private callback: EnterpriseLoopbackCallback | undefined
  private callbackWaiters: Array<(outcome: EnterpriseLoopbackCallback) => void> = []
  private rejectWaiters: Array<(cause: EnterpriseLoopbackError) => void> = []
  private disposed = false
  private readonly timeoutMs: number

  private constructor(
    readonly port: number,
    options: EnterpriseLoopbackListenerOptions,
  ) {
    this.timeoutMs = options.timeoutMs ?? ENTERPRISE_LOGIN_TIMEOUT_MS
  }

  /** Bind 127.0.0.1 on the first free candidate port. */
  static async start(options: EnterpriseLoopbackListenerOptions = {}): Promise<EnterpriseLoopbackListener> {
    const ports = options.ports ?? [0]
    let lastCause: unknown
    for (const port of ports) {
      const listener = await EnterpriseLoopbackListener.tryBind(port, options).catch((cause: unknown) => {
        lastCause = cause
        return undefined
      })
      if (listener !== undefined) return listener
    }
    throw new EnterpriseLoopbackError('bind-failed', 'no loopback port could be reserved for the OAuth redirect', { cause: lastCause })
  }

  private static tryBind(
    port: number,
    options: EnterpriseLoopbackListenerOptions,
  ): Promise<EnterpriseLoopbackListener> {
    return new Promise((resolve, reject) => {
      const server = createServer()
      const onListen = (): void => {
        const address = server.address()
        if (address === null || typeof address !== 'object') {
          server.close()
          reject(new EnterpriseLoopbackError('bind-failed', 'loopback listener reported no address'))
          return
        }
        const listener = new EnterpriseLoopbackListener(address.port, options)
        listener.server = server
        server.on('request', (req, res) => { listener.handleRequest(req, res) })
        server.on('clientError', (_cause, socket) => { socket.destroy() })
        // Post-bind errors (e.g. the interface disappearing) must not crash the
        // process; the listener fails through its timeout/disposal path.
        server.on('error', () => { listener.fail(new EnterpriseLoopbackError('bind-failed', 'loopback listener failed after binding')) })
        listener.armTimeout()
        resolve(listener)
      }
      server.once('error', (cause: Error) => {
        server.close()
        reject(cause)
      })
      server.once('listening', onListen)
      server.listen({ port, host: '127.0.0.1' })
    })
  }

  /** The redirect_uri to present in the authorization request. */
  get redirectUri(): string {
    return `http://127.0.0.1:${String(this.port)}${CALLBACK_PATH}`
  }

  /** Resolve with the first terminal callback, or reject on timeout/disposal. */
  waitForCallback(): Promise<EnterpriseLoopbackCallback> {
    if (this.callback !== undefined) return Promise.resolve(this.callback)
    if (this.disposed) {
      return Promise.reject(new EnterpriseLoopbackError('disposed', 'loopback listener was disposed'))
    }
    return new Promise((resolve, reject) => {
      this.callbackWaiters.push(resolve)
      this.rejectWaiters.push(reject)
    })
  }

  private settle(outcome: EnterpriseLoopbackCallback): void {
    if (this.callback !== undefined) return
    this.callback = outcome
    const waiters = this.callbackWaiters
    this.callbackWaiters = []
    this.rejectWaiters = []
    for (const waiter of waiters) waiter(outcome)
    this.closeSoon()
  }

  private fail(cause: EnterpriseLoopbackError): void {
    // Deliberately runs while disposed: dispose() itself routes through here
    // so pending waiters reject with 'disposed' instead of hanging.
    if (this.callback !== undefined) return
    const rejections = this.rejectWaiters
    this.callbackWaiters = []
    this.rejectWaiters = []
    for (const reject of rejections) reject(cause)
    this.closeSoon()
  }

  private armTimeout(): void {
    this.timeoutTimer = setTimeout(() => {
      this.fail(new EnterpriseLoopbackError('timeout', 'the authorization redirect did not arrive in time'))
    }, this.timeoutMs)
    this.timeoutTimer.unref?.()
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (this.disposed || this.callback !== undefined) {
      sendPage(res, 503, completionPage('invalid'))
      return
    }
    if (req.method !== 'GET') {
      sendPage(res, 405, completionPage('invalid'))
      return
    }
    if (!isLoopbackHostHeader(req.headers.host, this.port)) {
      sendPage(res, 400, completionPage('invalid'))
      return
    }
    const rawUrl = req.url ?? ''
    if (Buffer.byteLength(rawUrl, 'utf8') > MAX_URL_BYTES) {
      sendPage(res, 414, completionPage('invalid'))
      return
    }
    let target: URL
    try {
      target = new URL(rawUrl, `http://127.0.0.1:${String(this.port)}`)
    } catch {
      sendPage(res, 400, completionPage('invalid'))
      return
    }
    const parsed = parseCallbackTarget(target.href)
    if (parsed.kind === 'malformed') {
      sendPage(res, 400, completionPage('invalid'))
      return
    }
    this.settle(parsed)
    sendPage(res, 200, completionPage(parsed.kind === 'success' ? 'done' : 'denied'))
  }

  private closeSoon(): void {
    if (this.timeoutTimer !== undefined) clearTimeout(this.timeoutTimer)
    this.timeoutTimer = undefined
    const server = this.server
    this.server = undefined
    if (server !== undefined) server.close(() => { server.closeAllConnections?.() })
  }

  /** Stop listening and reject pending waiters; idempotent. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.fail(new EnterpriseLoopbackError('disposed', 'loopback listener was disposed'))
    this.closeSoon()
  }
}

export const enterpriseLoopbackConstants = Object.freeze({
  callbackPath: CALLBACK_PATH,
  timeoutMs: ENTERPRISE_LOGIN_TIMEOUT_MS,
  maxUrlBytes: MAX_URL_BYTES,
})
