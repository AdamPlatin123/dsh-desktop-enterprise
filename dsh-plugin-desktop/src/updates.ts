/** Cordis Host plugin for scheduled and interactive DSH Desktop updates. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { DESKTOP_UPDATE_CHECK_PATH } from './desktop-settings-contract.ts'
import { handleDesktopUpdateCheckRequest } from './desktop-settings-route.ts'
import {
  DESKTOP_UPDATE_VERSION_PATH,
  resolveEnterpriseUpdatePreset,
} from './enterprise-update-preset.ts'
import { enterpriseSessionRejection } from './enterprise-desktop-routes.ts'
import type {} from './runtime.ts'
import { startDesktopUpdateLifecycle } from './update-lifecycle.ts'

/** Stable Cordis plugin name. */
export const name = 'desktop-updates'

/** Native adapter required for network, tray, confirmation, and installer access. */
export const inject = ['desktopRuntime', 'webServer', 'connection']

const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Scheduled update policy. */
export interface Config {
  /** Enable background checks in packaged applications. */
  enabled: boolean
  /** Delay before the first background check after plugin activation. */
  initialDelayMs: number
  /** Delay between completion of one background check and the next attempt. */
  intervalMs: number
  /** Maximum duration of one version request before caller-owned cancellation. */
  requestTimeoutMs: number
}

/** Validated scheduled update policy. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  initialDelayMs: z.number().step(1).min(0).max(MAX_TIMER_DELAY_MS).default(60_000),
  intervalMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(6 * 60 * 60 * 1000),
  requestTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(15_000),
})

/**
 * Register effect-scoped update polling and its dynamic tray command.
 * @param ctx - Host context carrying the desktop native adapter.
 * @param config - validated polling and timeout values.
 */
export function apply(ctx: Context, config: Config): void {
  // Enterprise compliance (15.1): update checks exist only when a self-hosted
  // update source is preset. An unset or invalid preset registers nothing —
  // no tray command, no route, no background poll — and never falls back to
  // the public upstream endpoint.
  const preset = resolveEnterpriseUpdatePreset()
  if (preset.status === 'disabled') {
    ctx.logger.warn(
      preset.reason === undefined
        ? 'dsh-plugin-desktop: no self-hosted update source is preset; Desktop update checks stay disabled'
        : `dsh-plugin-desktop: ${preset.reason}; Desktop update checks stay disabled`,
    )
    return
  }
  ctx.effect(() => {
    const lifecycle = startDesktopUpdateLifecycle({
      adapter: ctx.desktopRuntime.updates,
      policy: config,
      locale: () => ctx.desktopRuntime.locale,
      registerTrayItem: item => ctx.desktopRuntime.registerTrayItem(item),
      endpoint: `${preset.origin}${DESKTOP_UPDATE_VERSION_PATH}`,
    })
    const rendererOrigin = `http://127.0.0.1:${String(ctx.webServer.port)}`
    const unregister = ctx.webServer.register({
      kind: 'exact',
      path: DESKTOP_UPDATE_CHECK_PATH,
      handler: (req, res) => {
        const rejection = ctx.connection.requestRejection(req)
        if (rejection !== undefined) {
          res.writeHead(rejection)
          res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        // Enterprise session layer (15.3): a signed-out or expired enterprise
        // session also closes this native-capability route.
        const enterpriseRejection = enterpriseSessionRejection(
          ctx.get('desktopEnterprise'),
          false,
        )
        if (enterpriseRejection !== undefined) {
          res.writeHead(enterpriseRejection)
          res.end('unauthorized')
          return
        }
        return handleDesktopUpdateCheckRequest(
          req,
          res,
          rendererOrigin,
          () => lifecycle.checkNow(),
          (operation, cause) => {
            ctx.logger.error(
              `dsh-plugin-desktop: failed to ${operation}: ${cause instanceof Error ? cause.message : String(cause)}`,
            )
          },
        )
      },
    })
    return async () => {
      unregister()
      await lifecycle.dispose()
    }
  }, 'dsh-plugin-desktop: update polling, confirmation, and installer handoff')
}
