import type { Context } from '@tnega/core'
import pg from 'pg'
import { bootstrapSchema } from './schema.js'
import { poolClient, type SqlClient } from './sql.js'
import { PgSessionStore, type PgSessionStoreOptions } from './store.js'
import type { WorkspaceResolver } from './workspaces.js'

export { PgSessionStore, type PgSessionStoreOptions } from './store.js'
export { bootstrapSchema } from './schema.js'
export { poolClient, type PgPoolLike, type SqlClient, type SqlQueryable } from './sql.js'
export { LOCAL_ACCOUNT_ID, LOCAL_DEVICE_ID, localWorkspaces, ownedLocalWorkspaces, type WorkspaceResolver, type WorkspaceRow } from './workspaces.js'

export interface SessionStorePgConfig {
  /** `postgresql://…`; the plugin opens a pool on it and closes it with the plugin. */
  url?: string
  /** A client the caller owns (PGlite in tests, a shared pool on a server). Wins over `url`. */
  sql?: SqlClient
  /** Create missing tables at mount. Default true; a database seeded from the plan's SQL needs nothing. */
  bootstrap?: boolean
  workspaces?: WorkspaceResolver
  leaseMs?: number
  renewMs?: number
}

/**
 * Mount: `await ctx.plugin(sessionStorePg, { url: process.env.DATABASE_URL })`.
 * Leases are released, and a pool the plugin opened is closed, with the plugin.
 */
export const sessionStorePg = {
  name: 'session-store-pg',
  async apply(ctx: Context, config: SessionStorePgConfig): Promise<void> {
    const pool = config.sql ? undefined : new pg.Pool({ connectionString: config.url })
    const sql = config.sql ?? (pool ? poolClient(pool) : undefined)
    if (!sql) throw new TypeError('session-store-pg needs a url or a sql client')
    try {
      if (config.bootstrap !== false) await bootstrapSchema(sql)
    } catch (error) {
      await pool?.end()
      throw error
    }
    const options: PgSessionStoreOptions = { sql }
    if (config.workspaces) options.workspaces = config.workspaces
    if (config.leaseMs !== undefined) options.leaseMs = config.leaseMs
    if (config.renewMs !== undefined) options.renewMs = config.renewMs
    const store = new PgSessionStore(ctx, options)
    ctx.fiber.effect(() => async () => {
      await store.releaseAll()
      await pool?.end()
    }, 'session-store-pg/leases')
  },
}

export const name = '@tnega/session-store-pg'
