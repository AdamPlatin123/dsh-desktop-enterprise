import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopEnterpriseLoginWindowInput } from '../src/enterprise-login-window.ts'

const electron = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void
  const windows: BrowserWindowFake[] = []
  class BrowserWindowFake {
    readonly onceListeners = new Map<string, Listener>()
    readonly listeners = new Map<string, Listener>()
    readonly webListeners = new Map<string, Listener>()
    readonly webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn((event: string, listener: Listener) => { this.webListeners.set(event, listener) }),
    }
    accessibleTitle = ''
    readonly isDestroyed = vi.fn(() => false)
    readonly isMinimized = vi.fn(() => false)
    readonly show = vi.fn()
    readonly focus = vi.fn()
    readonly restore = vi.fn()
    readonly removeMenu = vi.fn()
    readonly destroy = vi.fn()
    readonly loadFile = vi.fn(async () => {})
    readonly once = vi.fn((event: string, listener: Listener) => { this.onceListeners.set(event, listener) })
    readonly on = vi.fn((event: string, listener: Listener) => { this.listeners.set(event, listener) })
    constructor(readonly options: Electron.BrowserWindowConstructorOptions) { windows.push(this) }
  }
  return { app: { isHidden: vi.fn(() => false), show: vi.fn() }, BrowserWindow: BrowserWindowFake, windows }
})

vi.mock('electron', () => ({ app: electron.app, BrowserWindow: electron.BrowserWindow }))

import {
  DesktopEnterpriseLoginWindow,
  parseDesktopEnterpriseLoginAction,
} from '../src/enterprise-login-window.ts'

function windowInput(overrides: Partial<DesktopEnterpriseLoginWindowInput> = {}): DesktopEnterpriseLoginWindowInput {
  return {
    view: 'initial',
    serverOrigin: 'https://gateway.example.com',
    timeoutMinutes: 5,
    ...overrides,
  }
}

function latestWindow(): InstanceType<typeof electron.BrowserWindow> {
  const window = electron.windows.at(-1)
  if (window === undefined) throw new Error('no BrowserWindow was created')
  return window
}

beforeEach(() => { electron.windows.length = 0 })

describe('enterprise login action channel parsing', () => {
  it('accepts the action spellings the local document can produce', () => {
    expect(parseDesktopEnterpriseLoginAction('dsh-enterprise-login:open-browser')).toBe('open-browser')
    expect(parseDesktopEnterpriseLoginAction('dsh-enterprise-login://open-browser')).toBe('open-browser')
    expect(parseDesktopEnterpriseLoginAction('dsh-enterprise-login:copy-link')).toBe('copy-link')
    expect(parseDesktopEnterpriseLoginAction('dsh-enterprise-login:retry')).toBe('retry')
    expect(parseDesktopEnterpriseLoginAction('dsh-enterprise-login:back')).toBe('back')
    expect(parseDesktopEnterpriseLoginAction('dsh-enterprise-login:continue')).toBe('continue')
    expect(parseDesktopEnterpriseLoginAction('dsh-enterprise-login://continue/')).toBe('continue')
  })

  it('rejects everything that is not a bare known action', () => {
    expect(parseDesktopEnterpriseLoginAction('dsh-enterprise-login:continue?next=x')).toBeUndefined()
    expect(parseDesktopEnterpriseLoginAction('dsh-enterprise-login:continue#frag')).toBeUndefined()
    expect(parseDesktopEnterpriseLoginAction('dsh-enterprise-login:unknown-action')).toBeUndefined()
    expect(parseDesktopEnterpriseLoginAction('dsh-enterprise-login://evil.example/continue')).toBeUndefined()
    expect(parseDesktopEnterpriseLoginAction('http://127.0.0.1/continue')).toBeUndefined()
    expect(parseDesktopEnterpriseLoginAction('dsh-enterprise-login:')).toBeUndefined()
    expect(parseDesktopEnterpriseLoginAction(`dsh-enterprise-login:${'a'.repeat(2000)}`)).toBeUndefined()
  })
})

describe('enterprise login window', () => {
  it('creates an isolated sandboxed window and resolves continue through the scheme', async () => {
    const onAction = vi.fn()
    const loginWindow = new DesktopEnterpriseLoginWindow({
      locale: 'zh',
      platform: 'linux',
      input: windowInput(),
      onAction,
    })
    const pending = loginWindow.run()
    await Promise.resolve()
    const window = latestWindow()
    expect(window.options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'dsh-enterprise-login',
    })
    expect(window.loadFile).toHaveBeenCalledOnce()
    const navigate = window.webListeners.get('will-navigate') as (event: { preventDefault: () => void }, href: string) => void
    navigate({ preventDefault: vi.fn() }, 'dsh-enterprise-login:continue')
    await expect(pending).resolves.toEqual({ action: 'continue' })
    expect(window.destroy).toHaveBeenCalledOnce()
  })

  it('forwards non-terminal actions and resolves quit on window close', async () => {
    const onAction = vi.fn()
    const loginWindow = new DesktopEnterpriseLoginWindow({
      locale: 'en',
      platform: 'win32',
      input: windowInput({ view: 'denied' }),
      onAction,
    })
    const pending = loginWindow.run()
    await Promise.resolve()
    const window = latestWindow()
    const navigate = window.webListeners.get('will-navigate') as (event: { preventDefault: () => void }, href: string) => void
    navigate({ preventDefault: vi.fn() }, 'dsh-enterprise-login:open-browser')
    expect(onAction).toHaveBeenCalledWith('open-browser')
    navigate({ preventDefault: vi.fn() }, 'dsh-enterprise-login:copy-link')
    expect(onAction).toHaveBeenCalledWith('copy-link')
    const closed = window.listeners.get('closed') as () => void
    closed()
    await expect(pending).resolves.toEqual({ action: 'quit' })
  })

  it('pushes view updates by reloading the document with fresh state', async () => {
    const loginWindow = new DesktopEnterpriseLoginWindow({
      locale: 'zh',
      platform: 'linux',
      input: windowInput(),
      onAction: () => {},
    })
    const pending = loginWindow.run()
    await Promise.resolve()
    const window = latestWindow()
    loginWindow.showView(windowInput({ view: 'waiting' }))
    expect(window.loadFile).toHaveBeenCalledTimes(2)
    const secondCall = window.loadFile.mock.calls[1] as unknown as [string, { query: Record<string, string> }]
    expect(secondCall[1].query.locale).toBe('zh')
    const state = JSON.parse(Buffer.from(secondCall[1].query.state ?? '', 'base64url').toString('utf8')) as DesktopEnterpriseLoginWindowInput
    expect(state.view).toBe('waiting')
    loginWindow.show()
    expect(pending).toBeInstanceOf(Promise)
  })

  it('cannot run twice', async () => {
    const loginWindow = new DesktopEnterpriseLoginWindow({
      locale: 'en',
      platform: 'linux',
      input: windowInput(),
      onAction: () => {},
    })
    const pending = loginWindow.run()
    await expect(loginWindow.run()).rejects.toThrow(/once/u)
    const closed = latestWindow().listeners.get('closed') as () => void
    closed()
    await expect(pending).resolves.toEqual({ action: 'quit' })
  })
})
