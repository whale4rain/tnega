import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@tnega/core'
import { isAccountRole, mayManage, runsHost, type Account, type AccountRole, type AccountService } from '@tnega/accounts'
import type { DaemonRegistry } from '@tnega/daemons'
import type { MachinePool, MachineRow } from '@tnega/machine-pool'
import { HttpError, sendError, sendJson } from '@tnega/web-kit'

/**
 * `@tnega/server-admin`: what the owners and admins of a tnega server need to
 * look after it from the web app, in one small JSON API under `/api/admin/`.
 *
 * - `GET  /api/admin/overview`: people, every device, the daemons connected
 *   now, and the boxes with their state.
 * - `POST /api/admin/boxes/pause?id=` and `POST /api/admin/boxes/stop?id=`.
 * - `DELETE /api/admin/devices?account=&id=`: revoke a device (signs it out,
 *   and a daemon on it is disconnected).
 *
 * A Consumer only: it reads `ctx.accounts`, and `ctx.daemons` and
 * `ctx.machinePool` when the server has them, and owns no state. The sign-in
 * guard (`accounts-routes`) has already said who is asking; anyone who does
 * not run the host gets 403.
 */

export interface AdminPerson {
  id: string
  login: string
  name: string
  role: string
  disabled: boolean
}

export interface AdminDevice {
  id: string
  accountId: string
  kind: 'client' | 'daemon'
  name: string
  lastSeen?: string
  /** A daemon on this device is connected right now. */
  connected: boolean
  connectedAt?: string
  /** The device is the daemon of a box, not a person's machine. */
  box: boolean
}

export interface AdminBox {
  id: string
  accountId: string
  workspace: string
  provider: string
  state: MachineRow['state']
  lastUsed: string
  /** Its daemon is connected right now. */
  connected: boolean
}

export interface AdminOverview {
  people: AdminPerson[]
  devices: AdminDevice[]
  /** Absent when this server runs no boxes. */
  boxes?: { provider: string; maxRunning: number; list: AdminBox[] }
}

function person(account: Account): AdminPerson {
  return { id: account.id, login: account.login, name: account.name, role: account.role, disabled: account.disabled }
}

export async function adminOverview(accounts: AccountService, daemons: DaemonRegistry | undefined, pool: MachinePool | undefined): Promise<AdminOverview> {
  const people = await accounts.listAccounts()
  const rows = pool ? await pool.list() : []
  const boxDevices = new Set(rows.flatMap(row => row.deviceId ? [row.deviceId] : []))
  const live = new Map((daemons?.list() ?? []).map(daemon => [daemon.deviceId, daemon]))
  const devices: AdminDevice[] = []
  for (const account of people) {
    for (const device of await accounts.listDevices(account.id)) {
      const daemon = live.get(device.id)
      devices.push({
        id: device.id,
        accountId: account.id,
        kind: device.kind,
        name: device.name,
        ...(device.lastSeen ? { lastSeen: device.lastSeen } : {}),
        connected: daemon !== undefined,
        ...(daemon ? { connectedAt: daemon.connectedAt } : {}),
        box: boxDevices.has(device.id),
      })
    }
  }
  return {
    people: people.map(person),
    devices,
    ...(pool ? {
      boxes: {
        provider: pool.provider,
        maxRunning: pool.maxRunning,
        list: rows.map(row => ({
          id: row.id,
          accountId: row.accountId,
          workspace: row.workspace,
          provider: row.provider,
          state: row.state,
          lastUsed: new Date(row.lastUsed).toISOString(),
          connected: row.deviceId !== undefined && live.has(row.deviceId),
        })),
      },
    } : {}),
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

function idParam(url: URL, name: string): string {
  const value = url.searchParams.get(name) ?? ''
  if (!UUID.test(value)) throw new HttpError(400, `${name} must be an id`)
  return value
}

export const serverAdmin = {
  name: 'server-admin',
  inject: ['accounts', 'webServer'],
  apply(ctx: Context): void {
    const accounts: AccountService = ctx.get('accounts')
    const web = ctx.get('webServer')
    // Optional: a server without boxes has neither.
    const daemons = (): DaemonRegistry | undefined => ctx.get('daemons', false)
    const pool = (): MachinePool | undefined => ctx.get('machinePool', false)

    const admin = (req: IncomingMessage): { accountId: string; role: AccountRole } => {
      const principal = web.attributes(req).principal
      if (!principal) throw new HttpError(401, 'sign in first')
      if (!isAccountRole(principal.role) || !runsHost(principal.role)) throw new HttpError(403, 'only owners and admins can do this')
      return { accountId: principal.accountId, role: principal.role }
    }

    const handle = (method: 'GET' | 'POST' | 'DELETE', path: string, run: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>): void => {
      ctx.fiber.effect(() => web.register({
        kind: 'exact',
        method,
        path,
        handler: async (req, res, url) => {
          try {
            admin(req)
            await run(req, res, url)
          } catch (error) {
            if (error instanceof HttpError) { sendError(res, error.status, error.message); return }
            throw error
          }
        },
      }), `server-admin ${method} ${path}`)
    }

    const box = (action: 'pause' | 'stop') => async (_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
      const machines = pool()
      if (!machines) throw new HttpError(404, 'this server runs no boxes')
      const id = idParam(url, 'id')
      if (!await machines.row(id)) throw new HttpError(404, 'no such box')
      await machines[action](id)
      sendJson(res, 200, { id, done: action })
    }

    handle('GET', '/api/admin/overview', async (_req, res) => {
      sendJson(res, 200, await adminOverview(accounts, daemons(), pool()))
    })
    handle('POST', '/api/admin/boxes/pause', box('pause'))
    handle('POST', '/api/admin/boxes/stop', box('stop'))
    handle('DELETE', '/api/admin/devices', async (req, res, url) => {
      const actor = admin(req)
      const accountId = idParam(url, 'account')
      const id = idParam(url, 'id')
      const owner = await accounts.findAccount(accountId)
      if (!owner) throw new HttpError(404, 'no such account')
      // An admin looks after members' devices; an owner's are for owners.
      if (owner.id !== actor.accountId && !mayManage(actor.role, owner.role)) throw new HttpError(403, `your role cannot sign out an ${owner.role}'s device`)
      if (!await accounts.revokeDevice(accountId, id, actor.accountId)) throw new HttpError(404, 'no such device')
      daemons()?.disconnect(id, 'device revoked')
      sendJson(res, 200, { revoked: id })
    })
  },
}

export const name = '@tnega/server-admin'
