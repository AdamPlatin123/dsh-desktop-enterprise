/**
 * Desktop-owned session-expiry banner (R18 desktop-side 401 mapping).
 *
 * The gateway's llm-egress answers an expired or revoked desktop token with
 * 401 `invalid_token` / `token_revoked`, and that body reaches the session
 * error stream as the failing turn's message text. Instead of letting the
 * upstream error rendering stand alone, Desktop watches the same
 * `api-session/error` carrier, detects the enterprise rejection, and raises a
 * frame-wide banner with a direct re-login entry (the launcher-owned sign-in
 * window) — no upstream conversation markup is modified.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/remote-events'
import type { DesktopSettingsApi } from './desktop-settings-api.ts'

/** Locale namespace owned by the enterprise session banner. */
export const DESKTOP_ENTERPRISE_LOCALE_NAMESPACE = 'desktop.enterprise'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Enterprise session banner copy. */
    'desktop.enterprise': keyof typeof bannerCopy
  }
}

/**
 * Whether one session-error message is the enterprise token chain rejecting
 * the desktop egress token (as opposed to any other model or network error).
 */
export function detectEnterpriseSessionRejection(message: string): boolean {
  if (message.length > 8_192) return false
  return message.includes('401')
    && (message.includes('invalid_token') || message.includes('token_revoked'))
}

const zh = {
  sessionExpiredTitle: '登录已过期或已被吊销',
  sessionExpiredBody: '模型调用需要重新登录后才能继续。你的工作内容不受影响。',
  reauth: '重新登录',
  dismiss: '关闭',
} as const

const bannerCopy = zh

const en: Record<keyof typeof zh, string> = {
  sessionExpiredTitle: 'Your sign-in has expired or was revoked',
  sessionExpiredBody: 'Model calls need a fresh sign-in before they can continue. Your work is untouched.',
  reauth: 'Sign in again',
  dismiss: 'Dismiss',
}

const BANNER_ID = 'dsh-desktop-enterprise-session-banner'
const MAX_TITLE_LENGTH = 256

interface BannerLocale {
  readonly t: (key: keyof typeof zh) => string
}

function upsertBanner(locale: BannerLocale, onReauth: () => void): void {
  let banner = document.getElementById(BANNER_ID)
  if (banner !== null) {
    banner.querySelector<HTMLButtonElement>('[data-action="reauth"]')?.focus()
    return
  }
  banner = document.createElement('div')
  banner.id = BANNER_ID
  banner.setAttribute('role', 'alert')
  banner.className = 'dshDesktopEnterpriseBanner'
  const copy = document.createElement('div')
  copy.className = 'dshDesktopEnterpriseBannerCopy'
  const title = document.createElement('span')
  title.className = 'dshDesktopEnterpriseBannerTitle'
  title.textContent = locale.t('sessionExpiredTitle').slice(0, MAX_TITLE_LENGTH)
  const body = document.createElement('span')
  body.className = 'dshDesktopEnterpriseBannerBody'
  body.textContent = locale.t('sessionExpiredBody')
  copy.append(title, body)
  const actions = document.createElement('div')
  actions.className = 'dshDesktopEnterpriseBannerActions'
  const reauth = document.createElement('button')
  reauth.type = 'button'
  reauth.className = 'dshDesktopEnterpriseBannerButton'
  reauth.dataset.action = 'reauth'
  reauth.textContent = locale.t('reauth')
  reauth.addEventListener('click', () => { onReauth() })
  const dismiss = document.createElement('button')
  dismiss.type = 'button'
  dismiss.className = 'dshDesktopEnterpriseBannerButton dshDesktopEnterpriseBannerButtonSecondary'
  dismiss.textContent = locale.t('dismiss')
  dismiss.addEventListener('click', () => { banner?.remove() })
  actions.append(reauth, dismiss)
  banner.append(copy, actions)
  document.body.prepend(banner)
  reauth.focus()
}

function ensureBannerStyles(): void {
  if (document.getElementById(`${BANNER_ID}-styles`) !== null) return
  const style = document.createElement('style')
  style.id = `${BANNER_ID}-styles`
  style.textContent = `
#${BANNER_ID} {
  position: fixed;
  inset-inline: 0;
  top: 0;
  z-index: 2147483000;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 16px;
  background: #b3261e;
  color: #fff;
  font-size: 13px;
  line-height: 1.4;
}
#${BANNER_ID} .dshDesktopEnterpriseBannerCopy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
#${BANNER_ID} .dshDesktopEnterpriseBannerTitle {
  font-weight: 600;
}
#${BANNER_ID} .dshDesktopEnterpriseBannerBody {
  opacity: 0.9;
}
#${BANNER_ID} .dshDesktopEnterpriseBannerActions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
#${BANNER_ID} .dshDesktopEnterpriseBannerButton {
  border: 1px solid rgba(255, 255, 255, 0.6);
  border-radius: 6px;
  background: transparent;
  color: #fff;
  padding: 5px 12px;
  font-size: 13px;
  cursor: pointer;
}
#${BANNER_ID} .dshDesktopEnterpriseBannerButton:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 1px;
}
#${BANNER_ID} .dshDesktopEnterpriseBannerButtonSecondary {
  border-color: rgba(255, 255, 255, 0.3);
  opacity: 0.85;
}
`
  document.head.appendChild(style)
}

/** Watch session errors and raise the re-login banner on enterprise 401s. */
export function applyEnterpriseSessionBanner(ctx: ClientContext, api: DesktopSettingsApi): void {
  const t = ctx.locale.bind(DESKTOP_ENTERPRISE_LOCALE_NAMESPACE)
  ctx.effect(
    () => ctx.locale.register(DESKTOP_ENTERPRISE_LOCALE_NAMESPACE, { zh, en }),
    'dsh-plugin-desktop: enterprise session banner dictionaries',
  )
  ctx.effect(
    () => {
      ensureBannerStyles()
      return () => undefined
    },
    'dsh-plugin-desktop: enterprise session banner styles',
  )
  ctx.remote.$on('api-session/error', (_sessionId: string, message: string) => {
    if (!detectEnterpriseSessionRejection(message)) return
    // Only an enterprise session owns the desktop LLM token whose rejection
    // this banner maps; a self-hosted provider's coincidental 401 with a
    // similar body must not raise Desktop's re-login surface.
    void api.readEnterpriseIdentity()
      .then(identity => {
        if (identity === undefined) return
        upsertBanner({ t: key => t(key) }, () => {
          void api.requestReauth().catch(() => undefined)
        })
      })
      .catch(() => undefined)
  })
}
