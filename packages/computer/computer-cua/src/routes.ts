import type { Context } from '@tnega/core'
import { sendJson } from '@tnega/web-kit'
import { findDriver } from './driver.js'

/** Where the official installer lives, per platform. */
export const DRIVER_INSTALL_URL = 'https://cua.ai/docs/cua-driver'

/** What the installer needs to be run, per platform. */
export const DRIVER_INSTALL_COMMAND = process.platform === 'win32'
  ? 'irm https://cua.ai/driver/install.ps1 | iex'
  : '/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"'

/** `GET /api/computer/setup`: whether this machine has the driver cua needs. */
export interface ComputerSetup {
  /**
   * `installed` when the driver was found the way the Provider finds it
   * (configured path, `TNEGA_CUA_DRIVER`, `PATH`, the installer's folder).
   */
  driver: 'installed' | 'missing'
  /** The path that was found, when it was. */
  path?: string
  install: { command: string; url: string }
}

/**
 * The setup hint: a read-only probe that never starts the driver.
 *
 * Computer use fails closed without the driver, and the failure text only
 * reaches the model after a call, so the interface has no way to tell someone
 * why the tools do nothing. This reports the one fact that fixes it, on the
 * same terms as `sandbox-setup`: a filesystem check, cached for the host's
 * lifetime, that does not decide how anything runs. Which driver is actually
 * used stays the Provider's business.
 */
export const computerSetupRoutes = {
  name: 'computer-setup',
  inject: ['webServer'],
  apply(ctx: Context, config: { driverPath?: string } = {}): void {
    let setup: Promise<ComputerSetup> | undefined
    ctx.fiber.effect(() => ctx.webServer.register({
      kind: 'exact',
      method: 'GET',
      path: '/api/computer/setup',
      handler: async (_req, res) => {
        setup ??= findDriver(config.driverPath).then(
          (path): ComputerSetup => ({
            driver: path ? 'installed' : 'missing',
            ...(path ? { path } : {}),
            install: { command: DRIVER_INSTALL_COMMAND, url: DRIVER_INSTALL_URL },
          }),
          (): ComputerSetup => ({
            driver: 'missing',
            install: { command: DRIVER_INSTALL_COMMAND, url: DRIVER_INSTALL_URL },
          }),
        )
        sendJson(res, 200, await setup)
      },
    }))
  },
}
