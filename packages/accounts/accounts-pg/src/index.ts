import type { Context } from '@tnega/core'
import pg from 'pg'
import { poolClient, type SqlClient } from './sql.js'
import { bootstrapAccountTables, PgAccountService } from './store.js'

export { bootstrapAccountTables, PgAccountService, type PgAccountServiceOptions } from './store.js'
export { hashPassword, verifyPassword } from './password.js'
export { poolClient, type PgPoolLike, type SqlClient, type SqlQueryable } from './sql.js'

export interface AccountsPgConfig {
  /** `postgresql://…`; the plugin opens a small pool and closes it with the plugin. */
  url?: string
  /** A client the caller owns (PGlite in tests). Wins over `url`. */
  sql?: SqlClient
  /** Create missing tables at mount. Default true. */
  bootstrap?: boolean
}

/**
 * Provider of `ctx.accounts` on Postgres: `await ctx.plugin(accountsPg, { url })`.
 */
export const accountsPg = {
  name: 'accounts-pg',
  async apply(ctx: Context, config: AccountsPgConfig): Promise<void> {
    const pool = config.sql ? undefined : new pg.Pool({ connectionString: config.url, max: 4 })
    const sql = config.sql ?? (pool ? poolClient(pool) : undefined)
    if (!sql) throw new TypeError('accounts-pg needs a url or a sql client')
    try {
      if (config.bootstrap !== false) await bootstrapAccountTables(sql)
    } catch (error) {
      await pool?.end()
      throw error
    }
    new PgAccountService(ctx, { sql })
    if (pool) ctx.fiber.effect(() => () => pool.end(), 'accounts-pg/pool')
  },
}

export const name = '@tnega/accounts-pg'
