import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { workspaceStorageKey } from '@tnega/home'
import { assertSecretName, SecretError, type RememberedSecrets } from '@tnega/secrets'
import pg from 'pg'

/**
 * `@tnega/secrets-pg`: remembered secrets on a server, in the `secret` table
 * of `docs/plans/v2-server-mvp.md` §3.2, sealed with AES-256-GCM under the
 * server's master key (`TNEGA_MASTER_KEY`, §4.6). The database never holds a
 * value in the clear; a row is bound to its account and name, so a sealed
 * value copied onto another row does not open.
 *
 * A {@link RememberedSecrets} store for `@tnega/secrets-local`'s vault:
 * session-only secrets stay in the server's memory as before.
 */

/** The little of a Postgres client this store uses; `pg` and PGlite both fit. */
export interface SqlQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>
}

const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const FORMAT = 'tnega-secret-v1'

/**
 * The master key from its text form: 32 bytes as base64 or as 64 hex digits
 * (`openssl rand -base64 32`). Anything else is refused, so a short or
 * mistyped key never seals a secret.
 */
export function parseMasterKey(text: string | undefined): Buffer {
  const value = text?.trim() ?? ''
  const key = /^[0-9a-f]{64}$/iu.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64')
  if (key.length !== KEY_BYTES || (!/^[0-9a-f]{64}$/iu.test(value) && key.toString('base64') !== value)) {
    throw new SecretError('TNEGA_MASTER_KEY must be 32 bytes, as base64 (openssl rand -base64 32) or 64 hex digits', 'SECRET_INVALID')
  }
  return key
}

/** Names the key a value was sealed with, without revealing it: rows sealed under another key are told apart. */
export function masterKeyId(key: Buffer): string {
  return createHash('sha256').update(FORMAT).update(key).digest('hex').slice(0, 16)
}

/** The row name: the workspace's storage key, then the secret's name (names cannot hold `/`). */
function rowName(workspace: string, name: string): string {
  return `${workspaceStorageKey(workspace)}/${name}`
}

function binding(accountId: string, row: string): Buffer {
  return Buffer.from(`${FORMAT}\n${accountId}\n${row}`, 'utf8')
}

export function sealSecret(key: Buffer, accountId: string, row: string, value: string): Buffer {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(binding(accountId, row))
  const sealed = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), sealed])
}

export function openSecret(key: Buffer, accountId: string, row: string, sealed: Uint8Array): string {
  const bytes = Buffer.from(sealed)
  if (bytes.length < IV_BYTES + TAG_BYTES) throw new SecretError(`saved secret ${row} is damaged`, 'SECRET_FAILED')
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, IV_BYTES))
    decipher.setAAD(binding(accountId, row))
    decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
    return Buffer.concat([decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8')
  } catch (error) {
    throw new SecretError(`saved secret ${row} does not open: damaged, or moved from another row`, 'SECRET_FAILED', { cause: error })
  }
}

function column(row: unknown, name: string): unknown {
  if (typeof row !== 'object' || row === null || !(name in row)) throw new SecretError(`a secret row has no ${name}`, 'SECRET_FAILED')
  return Reflect.get(row, name)
}

/** The `account` and `secret` tables as the server plan defines them; idempotent. */
export async function bootstrapSecretTables(sql: SqlQueryable, accountId: string): Promise<void> {
  await sql.query(`create table if not exists account (id uuid primary key, name text not null, created_at timestamptz not null default now())`)
  await sql.query(`create table if not exists secret (
    id uuid primary key, account_id uuid not null references account,
    name text not null, ciphertext bytea not null, key_id text not null,
    unique (account_id, name)
  )`)
  await sql.query(`insert into account (id, name) values ($1, 'local') on conflict (id) do nothing`, [accountId])
}

export interface PgRememberedSecretsOptions {
  sql: SqlQueryable
  /** From {@link parseMasterKey}. */
  masterKey: Buffer
  /** The account the secrets belong to; the server checks the caller owns it. */
  accountId: string
}

export class PgRememberedSecrets implements RememberedSecrets {
  private readonly keyId: string

  constructor(private readonly options: PgRememberedSecretsOptions) {
    if (options.masterKey.length !== KEY_BYTES) throw new SecretError('the master key must be 32 bytes', 'SECRET_INVALID')
    this.keyId = masterKeyId(options.masterKey)
  }

  async read(workspace: string): Promise<Record<string, string>> {
    const prefix = `${workspaceStorageKey(workspace)}/`
    let rows: unknown[]
    try {
      ({ rows } = await this.options.sql.query(
        `select name, ciphertext, key_id from secret where account_id = $1 and starts_with(name, $2) order by name`,
        [this.options.accountId, prefix],
      ))
    } catch (error) {
      throw new SecretError('Saved secrets could not be read', 'SECRET_FAILED', { cause: error })
    }
    // Null prototype: a secret may legitimately be named `__proto__`.
    const secrets: Record<string, string> = Object.create(null)
    for (const row of rows) {
      const name = column(row, 'name')
      const sealed = column(row, 'ciphertext')
      const keyId = column(row, 'key_id')
      if (typeof name !== 'string' || !(sealed instanceof Uint8Array) || typeof keyId !== 'string') throw new SecretError('a secret row has the wrong shape', 'SECRET_FAILED')
      if (keyId !== this.keyId) throw new SecretError(`saved secret ${name.slice(prefix.length)} was sealed under another master key (${keyId}); set that TNEGA_MASTER_KEY or remove the secret`, 'SECRET_FAILED')
      secrets[name.slice(prefix.length)] = openSecret(this.options.masterKey, this.options.accountId, name, sealed)
    }
    return secrets
  }

  async set(workspace: string, name: string, value: string): Promise<void> {
    assertSecretName(name)
    const row = rowName(workspace, name)
    try {
      await this.options.sql.query(
        `insert into secret (id, account_id, name, ciphertext, key_id) values (gen_random_uuid(), $1, $2, $3, $4)
         on conflict (account_id, name) do update set ciphertext = excluded.ciphertext, key_id = excluded.key_id`,
        [this.options.accountId, row, sealSecret(this.options.masterKey, this.options.accountId, row, value), this.keyId],
      )
    } catch (error) {
      throw new SecretError('Secret could not be saved', 'SECRET_FAILED', { cause: error })
    }
  }

  async remove(workspace: string, name: string): Promise<boolean> {
    try {
      const { rows } = await this.options.sql.query(
        `delete from secret where account_id = $1 and name = $2 returning id`,
        [this.options.accountId, rowName(workspace, name)],
      )
      return rows.length > 0
    } catch (error) {
      throw new SecretError('Secret could not be removed', 'SECRET_FAILED', { cause: error })
    }
  }
}

/**
 * Remembered secrets on the database at `url`, on a small pool of their own.
 * The tables are created when missing. `close()` ends the pool.
 */
export async function openPgRememberedSecrets(options: { url: string; masterKey: Buffer; accountId: string }): Promise<PgRememberedSecrets & { close(): Promise<void> }> {
  const pool = new pg.Pool({ connectionString: options.url, max: 2 })
  try {
    await bootstrapSecretTables(pool, options.accountId)
  } catch (error) {
    await pool.end()
    throw error
  }
  const store = new PgRememberedSecrets({ sql: pool, masterKey: options.masterKey, accountId: options.accountId })
  return Object.assign(store, { close: () => pool.end() })
}

export const name = '@tnega/secrets-pg'
