import { Context, type Plugin } from '@tnega/core'
import type { AccountService } from '@tnega/accounts'
import { accountsPg } from '@tnega/accounts-pg'
import { accountsRoutes } from '@tnega/accounts-routes'
import { serverAdmin } from '@tnega/server-admin'
import { blobsLocal } from '@tnega/blobs-local'
import { sessionStoreJsonl } from '@tnega/session-store-jsonl'
import { LOCAL_ACCOUNT_ID, ownedLocalWorkspaces, sessionStorePg } from '@tnega/session-store-pg'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { SecretVault } from '@tnega/secrets-local'
import { openPgRememberedSecrets, parseMasterKey } from '@tnega/secrets-pg'

export { parseMasterKey }

/** Where a host keeps Sessions: JSONL files under the tnega home, or a Postgres database. */
export type SessionStoreSpec =
  | { kind: 'jsonl' }
  | { kind: 'postgres'; url: string }

export interface StateCapabilitySpec {
  sessions: SessionStoreSpec
  /**
   * Remembered secrets sealed with this master key in the same database
   * (AES-256-GCM). Only with a Postgres store; without it they stay in the
   * owner-only file under the tnega home.
   */
  masterKey?: Buffer
  /**
   * On a server with sign-in: a Session in `<membersRoot>/<login>/…` belongs
   * to that person's account in the database.
   */
  membersRoot?: string
}

/** The login whose own folder holds `path`, if it is under `membersRoot`. */
export function memberLoginOf(membersRoot: string, path: string): string | undefined {
  const rel = relative(resolve(membersRoot), resolve(path))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined
  return rel.split(sep)[0] || undefined
}

/**
 * The store a host's environment asks for. `TNEGA_SESSION_STORE=postgres`
 * with `DATABASE_URL` puts Sessions on Postgres; unset (or `jsonl`) keeps
 * them in files. Anything else is refused, never quietly a file store.
 */
export function stateSpecFromEnv(env: NodeJS.ProcessEnv = process.env): StateCapabilitySpec {
  const kind = env.TNEGA_SESSION_STORE?.trim().toLowerCase() || 'jsonl'
  if (kind === 'jsonl') return { sessions: { kind: 'jsonl' } }
  if (kind === 'postgres' || kind === 'pg') {
    const url = env.DATABASE_URL?.trim()
    if (!url) throw new Error('TNEGA_SESSION_STORE=postgres needs DATABASE_URL')
    const masterKey = env.TNEGA_MASTER_KEY?.trim()
    return { sessions: { kind: 'postgres', url }, ...(masterKey ? { masterKey: parseMasterKey(masterKey) } : {}) }
  }
  throw new Error(`unknown TNEGA_SESSION_STORE: ${env.TNEGA_SESSION_STORE}; use jsonl or postgres`)
}

/**
 * State seam of a host: image bytes in the local blob store, then the
 * Session store the spec names, on `ctx.blobs` and `ctx.sessionStore`.
 */
export const stateCapability: Plugin = {
  name: 'capability:state',
  async apply(ctx: Context, spec: StateCapabilitySpec) {
    // Image bytes live once under the tnega home; Sessions keep their hashes.
    await ctx.plugin(blobsLocal)
    if (spec.sessions.kind === 'postgres') {
      const membersRoot = spec.membersRoot
      await ctx.plugin(sessionStorePg, {
        url: spec.sessions.url,
        ...(membersRoot ? { workspaces: ownedLocalWorkspaces(key => memberLoginOf(membersRoot, key)) } : {}),
      })
    }
    else await ctx.plugin(sessionStoreJsonl)
  },
}

/**
 * The host's secret vault for a state spec: remembered secrets sealed in
 * Postgres when the spec has a database and a master key, otherwise in the
 * owner-only file. `close` lets go of the database.
 */
export async function openSecretVault(spec: StateCapabilitySpec): Promise<{ vault: SecretVault; close(): Promise<void> }> {
  if (spec.sessions.kind !== 'postgres' || !spec.masterKey) return { vault: new SecretVault(), close: async () => {} }
  const remembered = await openPgRememberedSecrets({ url: spec.sessions.url, masterKey: spec.masterKey, accountId: LOCAL_ACCOUNT_ID })
  return { vault: new SecretVault({ remembered }), close: () => remembered.close() }
}

/** Sign-in on a server: who may use it, and where members work. */
export interface AccountsCapabilitySpec {
  /** The database the accounts live in; the same one as the Sessions. */
  url: string
  /** Each member works in `<membersRoot>/<login>`. */
  membersRoot: string
  /** Behind a TLS reverse proxy: trust its `X-Forwarded-For` / `-Proto`. */
  trustProxy?: boolean
  secureCookie?: boolean | 'auto'
}

/**
 * Accounts seam of a server host: the Postgres Provider of `ctx.accounts` and
 * the routes that sign people in and guard every API request, and the
 * owners' and admins' `/api/admin/` routes. Needs
 * `ctx.webServer`. Local mode mounts none of it and asks nobody to sign in.
 */
export const accountsCapability: Plugin = {
  name: 'capability:accounts',
  async apply(ctx: Context, spec: AccountsCapabilitySpec) {
    await ctx.plugin(accountsPg, { url: spec.url })
    await ctx.plugin(accountsRoutes, {
      membersRoot: spec.membersRoot,
      ...(spec.trustProxy !== undefined ? { trustProxy: spec.trustProxy } : {}),
      ...(spec.secureCookie !== undefined ? { secureCookie: spec.secureCookie } : {}),
    })
    // The admin page's API: people, devices, daemons and boxes, for owners and admins.
    await ctx.plugin(serverAdmin)
  },
}

/**
 * `ctx.accounts` on its own, for `tnega server` commands run beside the
 * server (add a person, print an invite). `close` lets go of the database.
 */
export async function openAccounts(url: string): Promise<{ accounts: AccountService; close(): Promise<void> }> {
  const scope = new Context()
  await scope.plugin(accountsPg, { url })
  return { accounts: scope.get('accounts'), close: () => scope.fiber.dispose() }
}
