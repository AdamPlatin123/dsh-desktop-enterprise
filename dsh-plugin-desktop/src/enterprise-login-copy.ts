/** Bilingual copy for the enterprise login window (R20: follows the upstream locale split). */

import type { DesktopLocale } from './runtime.ts'

export type EnterpriseLoginView =
  | 'initial'
  | 'waiting'
  | 'success'
  | 'denied'
  | 'timeout'
  | 'error'
  | 'preset-missing'
  | 'storage-unavailable'

export interface EnterpriseLoginCopy {
  readonly title: string
  readonly appHeading: string
  readonly appIntro: string
  readonly serverLabel: string
  readonly serverHint: string
  readonly openBrowser: string
  readonly waitingTitle: string
  readonly waitingBody: string
  readonly reopenBrowser: string
  readonly copyLink: string
  readonly copied: string
  readonly successTitle: string
  readonly successBody: (username: string) => string
  readonly deniedTitle: string
  readonly deniedBody: string
  readonly back: string
  readonly timeoutTitle: string
  readonly timeoutBody: (minutes: number) => string
  readonly retry: string
  readonly errorTitle: string
  readonly retryHint: string
  readonly sessionExpiredNotice: string
  readonly disclosure: string
  readonly presetMissingTitle: string
  readonly presetMissingBody: string
  readonly storageUnavailableTitle: string
  readonly storageUnavailableBody: string
  readonly invalidState: string
}

const COPY: Record<DesktopLocale, EnterpriseLoginCopy> = {
  en: {
    title: 'Sign in to DSH Desktop',
    appHeading: 'Sign in to your organization workspace',
    appIntro: 'Your sign-in happens in the system browser. DSH Desktop never asks for your password here.',
    serverLabel: 'Organization server',
    serverHint: 'Your credentials are only entered on this server\'s own sign-in page. Verify the address before signing in.',
    openBrowser: 'Open browser to sign in',
    waitingTitle: 'Waiting for the browser…',
    waitingBody: 'Your browser opened the sign-in page. Once you finish there, you will return here automatically.',
    reopenBrowser: 'Open the browser again',
    copyLink: 'Copy sign-in link',
    copied: 'Link copied',
    successTitle: 'Signed in',
    successBody: username => `Welcome, ${username}.`,
    deniedTitle: 'Authorization denied',
    deniedBody: 'You declined the authorization request in the browser.',
    back: 'Back',
    timeoutTitle: 'Sign-in timed out',
    timeoutBody: minutes => `No response arrived within ${String(minutes)} minutes.`,
    retry: 'Try again',
    errorTitle: 'Sign-in failed',
    retryHint: 'Check that you can reach the organization server, then try again.',
    sessionExpiredNotice: 'Your sign-in session expired. Sign in again to continue; your work is untouched.',
    disclosure: 'While you use this client, the organization collects session metadata for auditing.',
    presetMissingTitle: 'Client configuration is incomplete',
    presetMissingBody: 'This installation has no organization server preset. Contact your administrator; the deployment guide (FORK.md, enterprise deployment section) explains how to preset the gateway address and OAuth client id at build time.',
    storageUnavailableTitle: 'Secure storage is unavailable',
    storageUnavailableBody: 'This system provides no OS-backed secret storage, so the sign-in session cannot be stored safely. Contact your administrator to enable a system keyring.',
    invalidState: 'The sign-in window could not load its state. Close this window and try again.',
  },
  zh: {
    title: '登录 DSH Desktop',
    appHeading: '登录组织工作区',
    appIntro: '登录在系统浏览器中完成，DSH Desktop 不会在这里索要您的密码。',
    serverLabel: '组织服务器',
    serverHint: '您的凭据只会输入到该服务器自带的登录页面，登录前请先核对地址。',
    openBrowser: '打开浏览器登录',
    waitingTitle: '等待浏览器完成…',
    waitingBody: '已在浏览器打开登录页，完成后将自动返回本应用。',
    reopenBrowser: '重新打开浏览器',
    copyLink: '复制登录链接',
    copied: '已复制链接',
    successTitle: '登录成功',
    successBody: username => `欢迎，${username}。`,
    deniedTitle: '你拒绝了授权',
    deniedBody: '你在浏览器中拒绝了本次授权请求。',
    back: '返回',
    timeoutTitle: '登录超时',
    timeoutBody: minutes => `${String(minutes)} 分钟内未收到登录结果。`,
    retry: '重试',
    errorTitle: '登录失败',
    retryHint: '请确认可以访问组织服务器后重试。',
    sessionExpiredNotice: '登录会话已过期，请重新登录以继续；本地数据不受影响。',
    disclosure: '使用本客户端期间，组织会上报会话元数据用于审计。',
    presetMissingTitle: '客户端配置不完整',
    presetMissingBody: '此安装缺少组织服务器预置配置。请联系管理员；部署文档（FORK.md 企业部署章节）说明如何在构建时预置网关地址与 OAuth 客户端 ID。',
    storageUnavailableTitle: '安全存储不可用',
    storageUnavailableBody: '当前系统没有操作系统级密钥存储，登录会话无法安全保存。请联系管理员启用系统密钥环。',
    invalidState: '登录窗口状态加载失败。请关闭此窗口后重试。',
  },
}

export function enterpriseLoginCopy(locale: DesktopLocale): EnterpriseLoginCopy {
  return COPY[locale]
}
