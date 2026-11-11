import { createServer, type IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Context } from '@tnega/core'
import type { AccountService, Principal } from '@tnega/accounts'
import { acceptDaemon, type PeerOptions } from '@tnega/daemon-protocol'
import type { DaemonRegistry } from '@tnega/daemons'
import { handshakeProblem, refuseUpgrade, ServerWebSocket } from './websocket.js'

export { handshakeProblem, MAX_MESSAGE_BYTES, refuseUpgrade, ServerWebSocket } from './websocket.js'

/**
 * The server's daemon door: a WebSocket at `/daemon` that a `tnega daemon`
 * dials with `Authorization: Bearer <device token>`. The token must be a live
 * daemon device of an enabled account (`ctx.accounts`); the handshake then
 * runs over the socket and the link goes into `ctx.daemons` under the device
 * id the server gave it. The token is checked again every minute, so revoking
 * the device or disabling the account drops the link.
 */
export interface DaemonGatewayConfig {
  /** Upgrade path. Default `/daemon`. */
  path?: string
  heartbeat?: PeerOptions['heartbeat']
  /** How often a connected token is checked again. Default one minute. */
  recheckMs?: number
  handshakeTimeoutMs?: number
  /**
   * Also listen here, for `/daemon` alone (every other request gets 404):
   * the address boxes on this host reach, so the web server itself can stay
   * on loopback.
   */
  listen?: { host: string; port: number }
}

function bearer(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization
  return auth?.startsWith('Bearer ') ? auth.slice(7).trim() || undefined : undefined
}

export const daemonGateway = {
  name: 'daemon-gateway',
  inject: ['accounts', 'daemons', 'webServer'],
  async apply(ctx: Context, config: DaemonGatewayConfig = {}): Promise<void> {
    const accounts: AccountService = ctx.get('accounts')
    const registry: DaemonRegistry = ctx.get('daemons')
    const sockets = new Set<ServerWebSocket>()

    const admit = async (req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
      const problem = handshakeProblem(req)
      if (problem) return refuseUpgrade(socket, 400, problem)
      const token = bearer(req)
      const principal: Principal | undefined = token ? await accounts.authenticate(token) : undefined
      if (!token || !principal) return refuseUpgrade(socket, 401, 'a daemon needs a valid device token')
      if (principal.device.kind !== 'daemon') return refuseUpgrade(socket, 403, 'this token is not a daemon token')
      const transport = ServerWebSocket.accept(req, socket, head)
      sockets.add(transport)
      transport.onClose(() => { sockets.delete(transport) })
      const link = await acceptDaemon(transport, {
        ...(config.heartbeat !== undefined ? { heartbeat: config.heartbeat } : {}),
        ...(config.handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs: config.handshakeTimeoutMs } : {}),
      })
      registry.add({ deviceId: principal.device.id, accountId: principal.account.id, link })
      // A revoked device or a disabled account loses its connection, not only its next one.
      const recheck = setInterval(() => {
        void accounts.authenticate(token).then(
          still => { if (!still || still.device.id !== principal.device.id) link.close('device token revoked') },
          () => undefined,
        )
      }, config.recheckMs ?? 60_000)
      recheck.unref()
      link.onClose(() => clearInterval(recheck))
    }

    const path = config.path ?? '/daemon'
    const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
      admit(req, socket, head).catch(() => {
        // A failed handshake already closed its socket; make sure of it.
        if (!socket.destroyed) socket.destroy()
      })
    }
    ctx.fiber.effect(() => ctx.get('webServer').registerUpgrade(path, upgrade), 'daemon-gateway/upgrade')
    if (config.listen) {
      const door = createServer((_req, res) => { res.writeHead(404, { connection: 'close' }).end() })
      door.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        if (new URL(req.url ?? '/', 'http://localhost').pathname === path) upgrade(req, socket, head)
        else refuseUpgrade(socket, 404, 'not found')
      })
      const { host, port } = config.listen
      await new Promise<void>((resolve, reject) => {
        door.once('error', reject)
        door.listen(port, host, () => { door.off('error', reject); resolve() })
      })
      ctx.fiber.effect(() => () => new Promise<void>(done => {
        door.close(() => done())
        door.closeAllConnections()
      }), 'daemon-gateway/listen')
    }
    ctx.fiber.effect(() => () => {
      for (const socket of [...sockets]) socket.close('server stopped')
    }, 'daemon-gateway/sockets')
  },
}

export const name = '@tnega/daemon-gateway'
