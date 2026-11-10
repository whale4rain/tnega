import { createHash } from 'node:crypto'
import { text, type SqlQueryable } from './sql.js'

/** The workspace row a Session hangs off: its id and the account that owns it. */
export interface WorkspaceRow {
  id: string
  accountId: string
}

/**
 * How the store turns a `WorkspaceKey` into a workspace row. With `create`,
 * a key the database does not know yet gets a row; without it, an unknown key
 * is `undefined` and a read finds nothing.
 */
export type WorkspaceResolver = (tx: SqlQueryable, key: string, create: boolean) => Promise<WorkspaceRow | undefined>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The owner of folders on this machine until sign-in exists (v2 server MVP §4.6). */
export const LOCAL_ACCOUNT_ID = '7e9a0000-0000-4000-8000-000000000001'
/**
 * The device those folders are on. It is born revoked with a token hash no
 * token has, so it can name folders but never sign in.
 */
export const LOCAL_DEVICE_ID = '7e9a0000-0000-4000-8000-000000000002'
const LOCAL_DEVICE_TOKEN_HASH = createHash('sha256').update('tnega:session-store-pg:local-device').digest('hex')

async function byId(tx: SqlQueryable, id: string): Promise<WorkspaceRow | undefined> {
  const { rows } = await tx.query(`select id::text as id, account_id::text as account_id from workspace where id = $1`, [id])
  const row = rows[0]
  return row === undefined ? undefined : { id: text(row, 'id'), accountId: text(row, 'account_id') }
}

async function byPath(tx: SqlQueryable, path: string): Promise<WorkspaceRow | undefined> {
  const { rows } = await tx.query(
    `select id::text as id, account_id::text as account_id from workspace where kind = 'daemon_path' and daemon_id = $1 and path = $2`,
    [LOCAL_DEVICE_ID, path],
  )
  const row = rows[0]
  return row === undefined ? undefined : { id: text(row, 'id'), accountId: text(row, 'account_id') }
}

/**
 * The resolver a single-owner host uses: a key that is the id of a workspace
 * row is that row (a server names workspaces by id); any other key is a
 * folder on this machine, kept as a `daemon_path` workspace of the local
 * device and account.
 */
export const localWorkspaces: WorkspaceResolver = (tx, key, create) => ownedLocalWorkspaces(() => undefined)(tx, key, create)

/**
 * {@link localWorkspaces} on a server where people sign in: a new folder's
 * row belongs to the account whose login `loginOf` names for it (a member's
 * own folder), and to the local account otherwise.
 */
export function ownedLocalWorkspaces(loginOf: (key: string) => string | undefined): WorkspaceResolver {
  return async (tx, key, create) => resolveLocal(tx, key, create, loginOf(key))
}

async function resolveLocal(tx: SqlQueryable, key: string, create: boolean, login: string | undefined): Promise<WorkspaceRow | undefined> {
  if (UUID.test(key)) {
    const found = await byId(tx, key)
    if (found) return found
  }
  const found = await byPath(tx, key)
  if (found || !create) return found
  await tx.query(`insert into account (id, name) values ($1, 'local') on conflict (id) do nothing`, [LOCAL_ACCOUNT_ID])
  await tx.query(
    `insert into device (id, account_id, kind, name, token_hash, revoked_at)
     values ($1, $2, 'daemon', 'this machine', decode($3, 'hex'), now()) on conflict (id) do nothing`,
    [LOCAL_DEVICE_ID, LOCAL_ACCOUNT_ID, LOCAL_DEVICE_TOKEN_HASH],
  )
  await tx.query(
    // `account.login` exists only where `@tnega/accounts-pg` made it, so it is
    // named only when a login is asked for.
    login === undefined
      ? `insert into workspace (id, account_id, kind, daemon_id, path) values (gen_random_uuid(), $1, 'daemon_path', $2, $3)
         on conflict (daemon_id, path) where kind = 'daemon_path' do nothing`
      : `insert into workspace (id, account_id, kind, daemon_id, path)
         values (gen_random_uuid(), coalesce((select id from account where login = $4), $1), 'daemon_path', $2, $3)
         on conflict (daemon_id, path) where kind = 'daemon_path' do nothing`,
    login === undefined ? [LOCAL_ACCOUNT_ID, LOCAL_DEVICE_ID, key] : [LOCAL_ACCOUNT_ID, LOCAL_DEVICE_ID, key, login],
  )
  return byPath(tx, key)
}
