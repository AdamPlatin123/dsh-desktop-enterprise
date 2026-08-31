/**
 * Vanilla renderer for the enterprise login window: reads its view state from
 * the document query (main owns all transitions) and reports actions back
 * through the custom-scheme navigation channel. No frameworks, no network.
 */

import { enterpriseLoginCopy } from '../../enterprise-login-copy.ts'
import type { DesktopLocale } from '../../runtime.ts'
import type { DesktopEnterpriseLoginWindowInput } from '../../enterprise-login-window.ts'
import './style.css'

const SUCCESS_CONTINUE_DELAY_MS = 2500

function decodeInput(encoded: string): DesktopEnterpriseLoginWindowInput | undefined {
  try {
    const json = new TextDecoder().decode(
      Uint8Array.from(atob(encoded.replace(/-/gu, '+').replace(/_/gu, '/')), c => c.charCodeAt(0)),
    )
    const parsed = JSON.parse(json) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const input = parsed as Record<string, unknown>
    if (typeof input.view !== 'string' || typeof input.serverOrigin !== 'string'
      || typeof input.timeoutMinutes !== 'number') return undefined
    return parsed as unknown as DesktopEnterpriseLoginWindowInput
  } catch {
    return undefined
  }
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function actionButton(label: string, action: string, primary = false): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  button.className = primary ? 'btn primary' : 'btn'
  button.addEventListener('click', () => {
    window.location.href = `dsh-enterprise-login:${action}`
  })
  return button
}

function render(root: HTMLElement, locale: DesktopLocale, frame: boolean, input: DesktopEnterpriseLoginWindowInput): void {
  const copy = enterpriseLoginCopy(locale)
  root.replaceChildren()
  const page = el('div', 'page')
  if (frame) page.appendChild(el('div', 'drag-region'))
  page.appendChild(el('h1', 'heading', copy.appHeading))
  page.appendChild(el('p', 'intro', copy.appIntro))

  const server = el('div', 'server-card')
  server.appendChild(el('div', 'server-label', copy.serverLabel))
  server.appendChild(el('div', 'server-origin', input.serverOrigin === '' ? '—' : input.serverOrigin))
  server.appendChild(el('div', 'server-hint', copy.serverHint))
  page.appendChild(server)

  const noticeText = input.notice === 'session-expired' ? copy.sessionExpiredNotice : undefined
  if (noticeText !== undefined && input.view === 'initial') page.appendChild(el('div', 'notice', noticeText))

  switch (input.view) {
    case 'initial': {
      page.appendChild(actionButton(copy.openBrowser, 'open-browser', true))
      break
    }
    case 'waiting': {
      page.appendChild(el('h2', 'view-title', copy.waitingTitle))
      page.appendChild(el('p', 'view-body', copy.waitingBody))
      const row = el('div', 'row')
      row.appendChild(actionButton(copy.reopenBrowser, 'open-browser'))
      row.appendChild(actionButton(copy.copyLink, 'copy-link'))
      page.appendChild(row)
      break
    }
    case 'success': {
      page.appendChild(el('h2', 'view-title', copy.successTitle))
      page.appendChild(el('p', 'view-body', copy.successBody(input.username ?? '')))
      const countdown = el('p', 'countdown', '…')
      page.appendChild(countdown)
      const deadline = Date.now() + SUCCESS_CONTINUE_DELAY_MS
      const timer = window.setInterval(() => {
        const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
        countdown.textContent = String(remaining)
        if (remaining <= 0) {
          window.clearInterval(timer)
          window.location.href = 'dsh-enterprise-login:continue'
        }
      }, 250)
      break
    }
    case 'denied': {
      page.appendChild(el('h2', 'view-title', copy.deniedTitle))
      page.appendChild(el('p', 'view-body', copy.deniedBody))
      page.appendChild(actionButton(copy.back, 'back'))
      break
    }
    case 'timeout': {
      page.appendChild(el('h2', 'view-title', copy.timeoutTitle))
      page.appendChild(el('p', 'view-body', copy.timeoutBody(input.timeoutMinutes)))
      const row = el('div', 'row')
      row.appendChild(actionButton(copy.retry, 'retry'))
      row.appendChild(actionButton(copy.copyLink, 'copy-link'))
      page.appendChild(row)
      break
    }
    case 'error': {
      page.appendChild(el('h2', 'view-title', copy.errorTitle))
      page.appendChild(el('p', 'view-body', copy.retryHint))
      if (input.errorMessage !== undefined && input.errorMessage.length > 0) {
        page.appendChild(el('p', 'detail', input.errorMessage))
      }
      const row = el('div', 'row')
      row.appendChild(actionButton(copy.retry, 'retry'))
      row.appendChild(actionButton(copy.copyLink, 'copy-link'))
      page.appendChild(row)
      break
    }
    case 'preset-missing': {
      page.appendChild(el('h2', 'view-title', copy.presetMissingTitle))
      page.appendChild(el('p', 'view-body', copy.presetMissingBody))
      break
    }
    case 'storage-unavailable': {
      page.appendChild(el('h2', 'view-title', copy.storageUnavailableTitle))
      page.appendChild(el('p', 'view-body', copy.storageUnavailableBody))
      break
    }
    default: {
      page.appendChild(el('p', 'view-body', copy.invalidState))
      break
    }
  }

  page.appendChild(el('footer', 'disclosure', copy.disclosure))
  root.appendChild(page)
}

function start(): void {
  const root = document.getElementById('root')
  if (root === null) return
  const params = new URLSearchParams(window.location.search)
  const locale: DesktopLocale = params.get('locale') === 'zh' ? 'zh' : 'en'
  const frame = params.get('frame') === 'true'
  const encodedState = params.get('state')
  const input = encodedState === null ? undefined : decodeInput(encodedState)
  root.replaceChildren()
  const page = el('div', 'page')
  if (input === undefined) {
    page.appendChild(el('p', 'view-body', enterpriseLoginCopy(locale).invalidState))
    root.appendChild(page)
    return
  }
  render(root, locale, frame, input)
}

void start()
