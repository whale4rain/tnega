/**
 * The little of a Postgres client this store uses: a query with positional
 * parameters, and a transaction. `pg` (through {@link poolClient}) and PGlite
 * both fit, so code-layer tests run on PGlite and a server on `pg`.
 *
 * Rows come back as `unknown`: the database is outside the type system, so
 * each read goes through the column readers below, which throw on a row of
 * the wrong shape instead of letting it travel on.
 */
export interface SqlQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>
}

export interface SqlClient extends SqlQueryable {
  /** Run `work` in one transaction: committed when it resolves, rolled back when it throws. */
  transaction<T>(work: (tx: SqlQueryable) => Promise<T>): Promise<T>
}

/** The parts of a `pg.Pool` this module needs. */
export interface PgPoolLike {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>
  connect(): Promise<{
    query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>
    release(error?: Error | boolean): void
  }>
}

/** A {@link SqlClient} over a `pg.Pool`: each transaction on its own connection. */
export function poolClient(pool: PgPoolLike): SqlClient {
  return {
    query: (text, params) => pool.query(text, params),
    async transaction<T>(work: (tx: SqlQueryable) => Promise<T>): Promise<T> {
      const connection = await pool.connect()
      let broken = false
      try {
        await connection.query('begin')
        const result = await work({ query: (text, params) => connection.query(text, params) })
        await connection.query('commit')
        return result
      } catch (error) {
        try {
          await connection.query('rollback')
        } catch {
          // A connection that cannot roll back is not given back to the pool.
          broken = true
        }
        throw error
      } finally {
        connection.release(broken)
      }
    },
  }
}

function field(row: unknown, column: string): unknown {
  if (typeof row !== 'object' || row === null || !(column in row)) throw new TypeError(`row has no column ${column}`)
  return Reflect.get(row, column)
}

export function text(row: unknown, column: string): string {
  const value = field(row, column)
  if (typeof value !== 'string') throw new TypeError(`column ${column} is not text`)
  return value
}

export function optionalText(row: unknown, column: string): string | undefined {
  const value = field(row, column)
  if (value === null) return undefined
  if (typeof value !== 'string') throw new TypeError(`column ${column} is not text`)
  return value
}

/** An integer column; `int8` arrives as a string from `pg`, so both are read. */
export function int(row: unknown, column: string): number {
  const value = field(row, column)
  const number = typeof value === 'string' ? Number(value) : value
  if (typeof number !== 'number' || !Number.isSafeInteger(number)) throw new TypeError(`column ${column} is not an integer`)
  return number
}

export function bool(row: unknown, column: string): boolean {
  const value = field(row, column)
  if (typeof value !== 'boolean') throw new TypeError(`column ${column} is not a boolean`)
  return value
}

/** A `jsonb` column, parsed by the driver. */
export function json(row: unknown, column: string): unknown {
  return field(row, column)
}
