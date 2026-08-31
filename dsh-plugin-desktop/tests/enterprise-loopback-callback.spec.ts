import { get } from 'node:http'
import { describe, expect, it } from 'vitest'
import {
  EnterpriseLoopbackListener,
} from '../src/enterprise-loopback-callback.ts'

function httpGet(url: string, headers: Record<string, string> = {}): Promise<{ status: number, body: string }> {
  return new Promise((resolve, reject) => {
    const request = get(url, { headers }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    request.on('error', reject)
  })
}

describe('enterprise loopback redirect receiver', () => {
  it('binds 127.0.0.1 on a random port and reports the matching redirect URI', async () => {
    const listener = await EnterpriseLoopbackListener.start()
    try {
      expect(listener.port).toBeGreaterThan(0)
      expect(listener.redirectUri).toBe(`http://127.0.0.1:${String(listener.port)}/cb`)
    } finally {
      listener.dispose()
    }
  })

  it('receives code+state once, answers the browser, and closes afterwards', async () => {
    const listener = await EnterpriseLoopbackListener.start({ timeoutMs: 4000 })
    const pending = listener.waitForCallback()
    const page = await httpGet(`${listener.redirectUri}?code=abc&state=xyz`)
    expect(page.status).toBe(200)
    expect(page.body).toContain('Sign-in complete')
    const callback = await pending
    expect(callback).toEqual({ kind: 'success', code: 'abc', state: 'xyz' })
    // The listener is single-shot: a second redirect is refused.
    const second = await httpGet(`${listener.redirectUri}?code=abc&state=xyz`)
    expect(second.status).toBe(503)
    listener.dispose()
  })

  it('surfaces authorization-error redirects like access_denied', async () => {
    const listener = await EnterpriseLoopbackListener.start({ timeoutMs: 4000 })
    const pending = listener.waitForCallback()
    const page = await httpGet(`${listener.redirectUri}?error=access_denied&error_description=denied+by+user&state=xyz`)
    expect(page.status).toBe(200)
    expect(page.body).toContain('Authorization denied')
    expect(await pending).toEqual({
      kind: 'error',
      error: 'access_denied',
      errorDescription: 'denied by user',
      state: 'xyz',
    })
    listener.dispose()
  })

  it('times out into a typed failure when no redirect arrives', async () => {
    const listener = await EnterpriseLoopbackListener.start({ timeoutMs: 60 })
    await expect(listener.waitForCallback()).rejects.toMatchObject({ code: 'timeout' })
    listener.dispose()
  })

  it('falls back to the next candidate port when one is occupied', async () => {
    const occupied = await EnterpriseLoopbackListener.start()
    const listener = await EnterpriseLoopbackListener.start({ ports: [occupied.port, 0] })
    try {
      expect(listener.port).not.toBe(occupied.port)
    } finally {
      listener.dispose()
      occupied.dispose()
    }
  })

  it('rejects disposal and malformed requests instead of guessing', async () => {
    const listener = await EnterpriseLoopbackListener.start({ timeoutMs: 4000 })
    listener.dispose()
    await expect(listener.waitForCallback()).rejects.toMatchObject({ code: 'disposed' })

    const second = await EnterpriseLoopbackListener.start({ timeoutMs: 4000 })
    try {
      const pending = second.waitForCallback()
      expect((await httpGet(`http://127.0.0.1:${String(second.port)}/other?code=a&state=b`)).status).toBe(400)
      expect((await httpGet(`http://127.0.0.1:${String(second.port)}/cb`)).status).toBe(400)
      expect((await httpGet(`http://127.0.0.1:${String(second.port)}/cb?code=a`)).status).toBe(400)
      // A Host header from a rebound DNS name must not reach the callback path.
      const rebinding = await new Promise<{ status: number }>((resolve, reject) => {
        const request = get(`http://127.0.0.1:${String(second.port)}/cb?code=a&state=b`, { headers: { host: 'evil.example' } }, res => {
          res.resume()
          res.on('end', () => resolve({ status: res.statusCode ?? 0 }))
        })
        request.on('error', reject)
      })
      expect(rebinding.status).toBe(400)
      second.dispose()
      await expect(pending).rejects.toMatchObject({ code: 'disposed' })
    } finally {
      second.dispose()
    }
    await expect(EnterpriseLoopbackListener.start({ ports: [0] })).resolves.toBeDefined()
  })
})
