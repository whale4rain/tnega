/**
 * The little of a Postgres client this Provider uses; `pg` (through
 * {@link poolClient}) and PGlite both fit. Rows come back as `unknown` and
 * are read through the column readers, which throw on the wrong shape.
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

/** A `timestamptz`: a `Date` from `pg` and PGlite, kept as ISO text. */
export function optionalTime(row: unknown, column: string): string | undefined {
  const value = field(row, column)
  if (value === null) return undefined
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') return new Date(value).toISOString()
  throw new TypeError(`column ${column} is not a time`)
}

export function time(row: unknown, column: string): string {
  const value = optionalTime(row, column)
  if (value === undefined) throw new TypeError(`column ${column} is null`)
  return value
}

export function int(row: unknown, column: string): number {
  const value = field(row, column)
  const number = typeof value === 'string' ? Number(value) : value
  if (typeof number !== 'number' || !Number.isSafeInteger(number)) throw new TypeError(`column ${column} is not an integer`)
  return number
}
