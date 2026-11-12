/**
 * The little of a Postgres client the pool uses; `pg` (through
 * {@link poolClient}) and PGlite both fit.
 */
export interface SqlQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>
}

export interface SqlClient extends SqlQueryable {
  transaction<T>(work: (tx: SqlQueryable) => Promise<T>): Promise<T>
}

export interface PgPoolLike {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>
  connect(): Promise<{
    query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>
    release(error?: Error | boolean): void
  }>
}

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

/** A `timestamptz` as milliseconds. */
export function millis(row: unknown, column: string): number {
  const value = field(row, column)
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string') return new Date(value).getTime()
  throw new TypeError(`column ${column} is not a time`)
}
