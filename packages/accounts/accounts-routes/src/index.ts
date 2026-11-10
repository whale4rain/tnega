import { mkdir, realpath } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Context } from '@tnega/core'
import {
  AccountError,
  isAccountRole,
  mayManage,
  runsHost,
  type Account,
  type AccountErrorCode,
  type AccountService,
  type CodePurpose,
  type Device,
  type Principal,
} from '@tnega/accounts'
import { HttpError, readJsonBody, sendError, sendJson, workspaceParam } from '@tnega/web-kit'
import { DEFAULT_RATE_LIMIT, FailureLimiter, type RateLimit } from './limiter.js'

export { DEFAULT_RATE_LIMIT, FailureLimiter, type RateLimit } from './limiter.js'

/**
 * `ctx.accounts` Consumer: sign-in over HTTP and the guard every API request
 * passes on a server.
 *
 * - No token, or a revoked one: 401, so the web app shows its sign-in page.
 * - Owners and admins run the host and pass on to every route.
 * - Members work in a folder of their own (`<membersRoot>/<login>`): the
 *   routes they may use are the workspace ones, and only with a `workspace`
 *   inside that folder. Host settings, plugins, terminals and other folders
 *   answer 403. They may not turn the sandbox off.
 * - Daemon tokens are for the daemon connection, not this API.
 *
 * Browsers keep the token in an HttpOnly cookie; the CLI and the TUI send it
 * as `Authorization: Bearer`. Every `/api/` request already needs the
 * `x-tnega-client` header, which a page on another site cannot send.
 */

export const TOKEN_COOKIE = 'tnega_token'
const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60

export interface AccountsRoutesConfig {
  /** The folder members' own workspaces live in. */
  membersRoot: string
  /**
   * Mark the cookie `Secure`. `auto` (default) does when the request came over
   * TLS, or through a proxy that says so and `trustProxy` is on.
   */
  secureCookie?: boolean | 'auto'
  /** Read the client address and scheme from `X-Forwarded-*` (behind a reverse proxy only). */
  trustProxy?: boolean
  rateLimit?: RateLimit
}

/** Routes a member may use, each scoped by its `workspace` query parameter. */
const MEMBER_WORKSPACE_ROUTES = [
  '/api/sessions',
  '/api/subagents/',
  '/api/files',
  '/api/changes',
  '/api/processes',
  '/api/projects',
  '/api/workspace-prompt',
  '/api/secrets',
  '/api/context',
]

const PUBLIC_ROUTES = new Set(['POST /api/auth/session', 'POST /api/auth/pair', 'POST /api/auth/invite', 'GET /api/health'])

function matchesRoute(pathname: string, route: string): boolean {
  return route.endsWith('/') ? pathname.startsWith(route) : pathname === route || pathname.startsWith(`${route}/`)
}

const STATUS: Record<AccountErrorCode, number> = {
  ACCOUNT_INVALID: 400,
  BAD_CREDENTIALS: 401,
  CODE_INVALID: 400,
  ACCOUNT_EXISTS: 409,
  ACCOUNT_NOT_FOUND: 404,
  LAST_OWNER: 409,
  FORBIDDEN: 403,
  ACCOUNTS_FAILED: 500,
}

function cookieToken(req: IncomingMessage): string | undefined {
  const header = req.headers.cookie
  if (!header) return undefined
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === TOKEN_COOKIE) return decodeURIComponent(rest.join('='))
  }
  return undefined
}

export function requestToken(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim()
  return cookieToken(req)
}

function field(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  return typeof value === 'string' ? value : undefined
}

function required(body: Record<string, unknown>, key: string): string {
  const value = field(body, key)
  if (value === undefined || value === '') throw new HttpError(400, `${key} is required`)
  return value
}

function publicAccount(account: Account) {
  return { id: account.id, login: account.login, name: account.name, role: account.role, disabled: account.disabled, createdAt: account.createdAt }
}

function publicDevice(device: Device, current?: string) {
  return { id: device.id, kind: device.kind, name: device.name, ...(device.lastSeen ? { lastSeen: device.lastSeen } : {}), ...(device.id === current ? { current: true } : {}) }
}

/** Whether `path` is `root` or inside it. */
export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
}

export const accountsRoutes = {
  name: 'accounts-routes',
  inject: ['accounts', 'webServer'],
  apply(ctx: Context, config: AccountsRoutesConfig): void {
    const accounts: AccountService = ctx.get('accounts')
    const web = ctx.get('webServer')
    const limiter = new FailureLimiter(config.rateLimit ?? DEFAULT_RATE_LIMIT)
    const principals = new WeakMap<IncomingMessage, Principal>()
    const membersRoot = resolve(config.membersRoot)

    const address = (req: IncomingMessage): string => {
      const forwarded = config.trustProxy ? req.headers['x-forwarded-for'] : undefined
      const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim()
      return first || req.socket.remoteAddress || 'unknown'
    }
    const secure = (req: IncomingMessage): boolean => {
      if (config.secureCookie === true || config.secureCookie === false) return config.secureCookie
      if ('encrypted' in req.socket && req.socket.encrypted === true) return true
      return config.trustProxy === true && req.headers['x-forwarded-proto'] === 'https'
    }
    const setCookie = (req: IncomingMessage, res: ServerResponse, token: string, maxAge = COOKIE_MAX_AGE_S): void => {
      res.setHeader('set-cookie', `${TOKEN_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure(req) ? '; Secure' : ''}`)
    }
    /** The member's own folder, made on first use. */
    const homeOf = async (account: Account): Promise<string> => {
      const home = join(membersRoot, account.login)
      await mkdir(home, { recursive: true })
      return home
    }
    const memberMayUse = async (account: Account, workspace: string): Promise<boolean> => {
      const home = await realpath(await homeOf(account))
      const wanted = resolve(workspace)
      if (!isInside(join(membersRoot, account.login), wanted)) return false
      // A link inside the folder must not lead out of it.
      const real = await realpath(wanted).catch(() => wanted)
      return isInside(home, real)
    }

    /** Run a code- or password-checking step, counting failures per address. */
    const limited = async <T>(req: IncomingMessage, work: () => Promise<T>): Promise<T> => {
      const from = address(req)
      const wait = limiter.blockedFor(from)
      if (wait > 0) throw new HttpError(429, `too many failed attempts; try again in ${Math.ceil(wait / 60_000)} minute(s)`)
      try {
        const result = await work()
        limiter.succeed(from)
        return result
      } catch (error) {
        if (error instanceof AccountError && (error.code === 'BAD_CREDENTIALS' || error.code === 'CODE_INVALID')) limiter.fail(from)
        throw error
      }
    }

    const handle = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, run: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>): void => {
      ctx.fiber.effect(() => web.register({
        kind: 'exact',
        method,
        path,
        handler: async (req, res, url) => {
          try {
            await run(req, res, url)
          } catch (error) {
            if (error instanceof AccountError) {
              sendError(res, STATUS[error.code], error.message)
              return
            }
            if (error instanceof HttpError) {
              sendError(res, error.status, error.message)
              return
            }
            throw error
          }
        },
      }), `accounts-routes ${method} ${path}`)
    }
    const principalOf = (req: IncomingMessage): Principal => {
      const principal = principals.get(req)
      if (!principal) throw new HttpError(401, 'sign in first')
      return principal
    }
    const hostRunner = (req: IncomingMessage): Principal => {
      const principal = principalOf(req)
      if (!runsHost(principal.account.role)) throw new HttpError(403, 'only owners and admins can do this')
      return principal
    }

    ctx.fiber.effect(() => web.registerGuard(async (req, res, url) => {
      if (!url.pathname.startsWith('/api/')) return false
      const method = (req.method ?? 'GET').toUpperCase()
      const token = requestToken(req)
      const principal = token ? await accounts.authenticate(token) : undefined
      if (PUBLIC_ROUTES.has(`${method} ${url.pathname}`)) {
        if (principal) principals.set(req, principal)
        return false
      }
      if (!principal) {
        sendError(res, 401, 'sign in to this tnega server')
        return true
      }
      if (principal.device.kind !== 'client') {
        sendError(res, 403, 'a daemon token cannot use this API')
        return true
      }
      principals.set(req, principal)
      const attributes = web.attributes(req)
      attributes.principal = { accountId: principal.account.id, login: principal.account.login, role: principal.account.role }
      if (runsHost(principal.account.role)) return false
      // A member from here on.
      attributes.sandboxRequired = true
      if (url.pathname.startsWith('/api/auth/')) return false
      if (url.pathname === '/api/workspaces' && method === 'GET') {
        const home = await homeOf(principal.account)
        sendJson(res, 200, { workspaces: [home], defaultWorkspace: home })
        return true
      }
      if (url.pathname === '/api/config' && method === 'GET') return false
      if (MEMBER_WORKSPACE_ROUTES.some(route => matchesRoute(url.pathname, route))) {
        const workspace = workspaceParam(url)
        if (workspace && await memberMayUse(principal.account, workspace)) return false
        sendError(res, 403, 'this workspace belongs to someone else')
        return true
      }
      sendError(res, 403, 'only owners and admins can do this')
      return true
    }), 'accounts-routes/guard')

    handle('POST', '/api/auth/session', async (req, res) => {
      const body = await readJsonBody(req, 16 * 1024)
      const issued = await limited(req, () => accounts.signIn(required(body, 'login'), required(body, 'password'), {
        name: field(body, 'device') ?? req.headers['user-agent']?.slice(0, 80) ?? 'browser',
        address: address(req),
      }))
      if (body.token === true) {
        sendJson(res, 200, { account: publicAccount(issued.principal.account), token: issued.token })
        return
      }
      setCookie(req, res, issued.token)
      sendJson(res, 200, { account: publicAccount(issued.principal.account) })
    })

    handle('GET', '/api/auth/session', async (req, res) => {
      const { account, device } = principalOf(req)
      const home = runsHost(account.role) ? undefined : await homeOf(account)
      sendJson(res, 200, { account: publicAccount(account), device: publicDevice(device, device.id), ...(home ? { workspace: home } : {}) })
    })

    handle('DELETE', '/api/auth/session', async (req, res) => {
      const token = requestToken(req)
      if (token) await accounts.signOut(token)
      setCookie(req, res, '', 0)
      sendJson(res, 200, { signedOut: true })
    })

    handle('POST', '/api/auth/pair', async (req, res) => {
      const body = await readJsonBody(req, 16 * 1024)
      const purpose: CodePurpose = body.purpose === 'daemon' ? 'daemon' : 'client'
      const issued = await limited(req, () => accounts.redeemCode(required(body, 'code'), {
        purpose,
        deviceName: field(body, 'device') ?? purpose,
      }))
      sendJson(res, 200, { account: publicAccount(issued.principal.account), device: publicDevice(issued.principal.device), token: issued.token })
    })

    handle('POST', '/api/auth/invite', async (req, res) => {
      const body = await readJsonBody(req, 16 * 1024)
      const name = field(body, 'name')
      const issued = await limited(req, () => accounts.redeemCode(required(body, 'code'), {
        purpose: 'invite',
        deviceName: field(body, 'device') ?? req.headers['user-agent']?.slice(0, 80) ?? 'browser',
        login: required(body, 'login'),
        password: required(body, 'password'),
        ...(name === undefined ? {} : { name }),
      }))
      setCookie(req, res, issued.token)
      sendJson(res, 201, { account: publicAccount(issued.principal.account) })
    })

    handle('POST', '/api/auth/codes', async (req, res) => {
      const { account } = principalOf(req)
      const body = await readJsonBody(req, 16 * 1024)
      const purpose = body.purpose
      if (purpose !== 'client' && purpose !== 'daemon' && purpose !== 'invite') throw new HttpError(400, 'purpose must be client, daemon or invite')
      if (purpose === 'invite') {
        const role = body.role === undefined ? 'member' : body.role
        if (!isAccountRole(role)) throw new HttpError(400, 'role must be owner, admin or member')
        if (!mayManage(account.role, role)) throw new HttpError(403, `your role cannot invite an ${role}`)
        sendJson(res, 201, await accounts.issueCode({ purpose, role, createdBy: account.id }))
        return
      }
      sendJson(res, 201, await accounts.issueCode({ purpose, accountId: account.id, createdBy: account.id }))
    })

    handle('GET', '/api/auth/devices', async (req, res) => {
      const { account, device } = principalOf(req)
      sendJson(res, 200, { devices: (await accounts.listDevices(account.id)).map(entry => publicDevice(entry, device.id)) })
    })

    handle('DELETE', '/api/auth/devices', async (req, res, url) => {
      const { account } = principalOf(req)
      const id = url.searchParams.get('id') ?? ''
      if (!await accounts.revokeDevice(account.id, id, account.id)) throw new HttpError(404, 'no such device')
      sendJson(res, 200, { revoked: id })
    })

    handle('PUT', '/api/auth/password', async (req, res) => {
      const { account, device } = principalOf(req)
      const body = await readJsonBody(req, 16 * 1024)
      // The current password again, so an unlocked browser cannot take the account over.
      await limited(req, async () => {
        if (!await accounts.checkPassword(account.id, required(body, 'current'))) throw new AccountError('wrong password', 'BAD_CREDENTIALS')
      })
      await accounts.setPassword(account.id, required(body, 'next'), { keepDevice: device.id, actor: account.id })
      sendJson(res, 200, { changed: true })
    })

    handle('GET', '/api/auth/users', async (req, res) => {
      hostRunner(req)
      sendJson(res, 200, { users: (await accounts.listAccounts()).map(publicAccount) })
    })

    handle('POST', '/api/auth/users', async (req, res) => {
      const { account } = hostRunner(req)
      const body = await readJsonBody(req, 16 * 1024)
      const role = body.role === undefined ? 'member' : body.role
      if (!isAccountRole(role)) throw new HttpError(400, 'role must be owner, admin or member')
      if (!mayManage(account.role, role)) throw new HttpError(403, `your role cannot add an ${role}`)
      const name = field(body, 'name')
      const created = await accounts.createAccount({
        login: required(body, 'login'),
        password: required(body, 'password'),
        role,
        ...(name === undefined ? {} : { name }),
      }, account.id)
      sendJson(res, 201, { user: publicAccount(created) })
    })

    handle('PATCH', '/api/auth/users', async (req, res, url) => {
      const { account } = hostRunner(req)
      const target = await accounts.findAccount(url.searchParams.get('id') ?? '')
      if (!target) throw new HttpError(404, 'no such account')
      const body = await readJsonBody(req, 16 * 1024)
      const role = body.role
      if (role !== undefined && !isAccountRole(role)) throw new HttpError(400, 'role must be owner, admin or member')
      if (!mayManage(account.role, target.role, role ?? target.role)) throw new HttpError(403, `your role cannot change an ${target.role}`)
      if (target.id === account.id && (body.disabled === true || (role !== undefined && role !== account.role))) {
        throw new HttpError(409, 'ask another owner to change your own role or disable you')
      }
      const name = field(body, 'name')
      const password = field(body, 'password')
      if (password !== undefined) await accounts.setPassword(target.id, password, { actor: account.id })
      const updated = await accounts.updateAccount(target.id, {
        ...(name === undefined ? {} : { name }),
        ...(role === undefined ? {} : { role }),
        ...(typeof body.disabled === 'boolean' ? { disabled: body.disabled } : {}),
      }, account.id)
      sendJson(res, 200, { user: publicAccount(updated) })
    })
  },
}

export const name = '@tnega/accounts-routes'
