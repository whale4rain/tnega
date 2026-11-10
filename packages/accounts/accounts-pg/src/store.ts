import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Context } from '@tnega/core'
import {
  AccountError,
  AccountService,
  assertPassword,
  formatCode,
  INVITE_TTL_MS,
  isAccountRole,
  MAX_CODE_TTL_MS,
  normalizeCode,
  normalizeLogin,
  normalizeName,
  PAIRING_TTL_MS,
  TOKEN_PREFIX,
  type Account,
  type AccountPatch,
  type AccountRole,
  type Device,
  type DeviceKind,
  type IssueCodeInput,
  type IssuedCode,
  type IssuedToken,
  type NewAccount,
  type Principal,
  type RedeemInput,
} from '@tnega/accounts'
import { decoyHash, hashPassword, verifyPassword } from './password.js'
import { int, optionalText, optionalTime, text, time, type SqlClient, type SqlQueryable } from './sql.js'

/**
 * The account tables. `account` and `device` are the plan's (§3.2); a person's
 * account adds a login, a role and a password hash to the plan's row, so the
 * local account the Session store makes (no login) never signs anyone in.
 * Idempotent, under the same advisory lock as the Session store's bootstrap.
 */
const TABLES = [
  `create table if not exists account (id uuid primary key, name text not null, created_at timestamptz not null default now())`,
  `alter table account add column if not exists login text`,
  `alter table account add column if not exists role text`,
  `alter table account add column if not exists password_hash text`,
  `alter table account add column if not exists disabled_at timestamptz`,
  `create unique index if not exists account_login on account (login) where login is not null`,
  `create table if not exists device (
    id uuid primary key, account_id uuid not null references account,
    kind text not null check (kind in ('client','daemon')),
    name text not null, token_hash bytea not null unique,
    protocol_version int, capabilities jsonb, last_seen timestamptz,
    revoked_at timestamptz
  )`,
  `create table if not exists auth_code (
    code_hash bytea primary key,
    purpose text not null check (purpose in ('client','daemon','invite')),
    account_id uuid references account, role text, created_by uuid references account,
    expires_at timestamptz not null, used_at timestamptz
  )`,
  `create table if not exists audit (id bigserial primary key, at timestamptz not null default now(),
    actor text not null, action text not null, target text, detail jsonb)`,
]

export async function bootstrapAccountTables(sql: SqlClient): Promise<void> {
  await sql.transaction(async tx => {
    await tx.query(`select pg_advisory_xact_lock(7104553551)`)
    for (const statement of TABLES) await tx.query(statement)
  })
}

/** An account id; other actors (`cli`, `server`) only reach the audit log. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest()

const ACCOUNT_COLUMNS = `a.id::text as id, a.login, a.name, a.role, a.disabled_at, a.created_at`

function accountFrom(row: unknown): Account {
  const role = text(row, 'role')
  if (!isAccountRole(role)) throw new AccountError(`account has an unknown role ${role}`, 'ACCOUNTS_FAILED')
  return {
    id: text(row, 'id'),
    login: text(row, 'login'),
    name: text(row, 'name'),
    role,
    disabled: optionalTime(row, 'disabled_at') !== undefined,
    createdAt: time(row, 'created_at'),
  }
}

function deviceKind(value: string): DeviceKind {
  if (value !== 'client' && value !== 'daemon') throw new AccountError(`device has an unknown kind ${value}`, 'ACCOUNTS_FAILED')
  return value
}

function deviceFrom(row: unknown, prefix = ''): Device {
  const lastSeen = optionalTime(row, `${prefix}last_seen`)
  return {
    id: text(row, `${prefix}id`),
    accountId: text(row, `${prefix}account_id`),
    kind: deviceKind(text(row, `${prefix}kind`)),
    name: text(row, `${prefix}name`),
    ...(lastSeen ? { lastSeen } : {}),
    revoked: optionalTime(row, `${prefix}revoked_at`) !== undefined,
  }
}

function deviceName(name: string): string {
  const value = name.replace(/\s+/gu, ' ').trim().slice(0, 80)
  return value || 'device'
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505'
}

export interface PgAccountServiceOptions {
  sql: SqlClient
  /** How often `last_seen` is written for a busy device. */
  touchMs?: number
  now?: () => number
}

export class PgAccountService extends AccountService {
  private readonly sql: SqlClient
  private readonly touchMs: number
  private readonly now: () => number
  private readonly touched = new Map<string, number>()

  constructor(ctx: Context, options: PgAccountServiceOptions) {
    super(ctx)
    this.sql = options.sql
    this.touchMs = options.touchMs ?? 60_000
    this.now = options.now ?? Date.now
  }

  private async audit(tx: SqlQueryable, actor: string | undefined, action: string, target?: string, detail?: Record<string, unknown>): Promise<void> {
    await tx.query(`insert into audit (actor, action, target, detail) values ($1, $2, $3, $4)`, [actor ?? 'server', action, target ?? null, detail ? JSON.stringify(detail) : null])
  }

  private async newDevice(tx: SqlQueryable, accountId: string, kind: DeviceKind, name: string): Promise<{ token: string; device: Device }> {
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
    const id = randomUUID()
    const { rows } = await tx.query(
      `insert into device (id, account_id, kind, name, token_hash, last_seen) values ($1, $2, $3, $4, $5, now())
       returning id::text as id, account_id::text as account_id, kind, name, last_seen, revoked_at`,
      [id, accountId, kind, deviceName(name), sha256(token)],
    )
    return { token, device: deviceFrom(rows[0]) }
  }

  private async insertAccount(tx: SqlQueryable, input: NewAccount, actor: string | undefined): Promise<Account> {
    const login = normalizeLogin(input.login)
    assertPassword(input.password)
    if (!isAccountRole(input.role)) throw new AccountError(`unknown role ${String(input.role)}`, 'ACCOUNT_INVALID')
    const name = normalizeName(input.name, login)
    const hash = await hashPassword(input.password)
    try {
      const { rows } = await tx.query(
        `insert into account as a (id, name, login, role, password_hash) values ($1, $2, $3, $4, $5) returning ${ACCOUNT_COLUMNS}`,
        [randomUUID(), name, login, input.role, hash],
      )
      const account = accountFrom(rows[0])
      await this.audit(tx, actor, 'account.create', account.id, { login, role: input.role })
      return account
    } catch (error) {
      if (isUniqueViolation(error)) throw new AccountError(`the login ${login} is taken`, 'ACCOUNT_EXISTS', { cause: error })
      throw error
    }
  }

  async createAccount(input: NewAccount, createdBy?: string): Promise<Account> {
    return this.sql.transaction(tx => this.insertAccount(tx, input, createdBy))
  }

  async listAccounts(): Promise<Account[]> {
    const { rows } = await this.sql.query(`select ${ACCOUNT_COLUMNS} from account a where a.login is not null order by a.login`)
    return rows.map(accountFrom)
  }

  async findAccount(idOrLogin: string): Promise<Account | undefined> {
    const key = idOrLogin.trim()
    const byId = UUID.test(key)
    const { rows } = await this.sql.query(
      `select ${ACCOUNT_COLUMNS} from account a where a.login is not null and ${byId ? 'a.id = $1::uuid' : 'a.login = $1'}`,
      [byId ? key : key.toLowerCase()],
    )
    return rows[0] === undefined ? undefined : accountFrom(rows[0])
  }

  /** Owners who can still sign in, other than `except`; locks their rows so two demotions cannot pass together. */
  private async otherActiveOwners(tx: SqlQueryable, except: string): Promise<number> {
    const { rows } = await tx.query(
      `select a.id from account a where a.role = 'owner' and a.disabled_at is null and a.login is not null and a.id <> $1 for update`,
      [except],
    )
    return rows.length
  }

  async updateAccount(id: string, patch: AccountPatch, actor?: string): Promise<Account> {
    if (patch.role !== undefined && !isAccountRole(patch.role)) throw new AccountError(`unknown role ${String(patch.role)}`, 'ACCOUNT_INVALID')
    return this.sql.transaction(async tx => {
      const { rows: found } = await tx.query(`select ${ACCOUNT_COLUMNS} from account a where a.id = $1::uuid and a.login is not null for update`, [id])
      if (found[0] === undefined) throw new AccountError('no such account', 'ACCOUNT_NOT_FOUND')
      const current = accountFrom(found[0])
      const losesOwner = current.role === 'owner' && !current.disabled
        && ((patch.role !== undefined && patch.role !== 'owner') || patch.disabled === true)
      if (losesOwner && await this.otherActiveOwners(tx, id) === 0) {
        throw new AccountError('the server needs at least one owner who can sign in', 'LAST_OWNER')
      }
      const name = patch.name === undefined ? current.name : normalizeName(patch.name, current.login)
      const role = patch.role ?? current.role
      const disabled = patch.disabled ?? current.disabled
      const { rows } = await tx.query(
        `update account a set name = $2, role = $3,
           disabled_at = case when $4::boolean then coalesce(a.disabled_at, now()) else null end
         where a.id = $1::uuid returning ${ACCOUNT_COLUMNS}`,
        [id, name, role, disabled],
      )
      if (disabled && !current.disabled) {
        await tx.query(`update device set revoked_at = now() where account_id = $1::uuid and revoked_at is null`, [id])
      }
      await this.audit(tx, actor, 'account.update', id, { ...patch })
      return accountFrom(rows[0])
    })
  }

  async setPassword(id: string, password: string, options: { keepDevice?: string; actor?: string } = {}): Promise<void> {
    assertPassword(password)
    const hash = await hashPassword(password)
    await this.sql.transaction(async tx => {
      const { rows } = await tx.query(`update account set password_hash = $2 where id = $1::uuid and login is not null returning id`, [id, hash])
      if (rows.length === 0) throw new AccountError('no such account', 'ACCOUNT_NOT_FOUND')
      await tx.query(
        `update device set revoked_at = now() where account_id = $1::uuid and kind = 'client' and revoked_at is null and ($2::uuid is null or id <> $2::uuid)`,
        [id, options.keepDevice ?? null],
      )
      await this.audit(tx, options.actor, 'account.password', id)
    })
  }

  async checkPassword(id: string, password: string): Promise<boolean> {
    const { rows } = await this.sql.query(`select password_hash from account where id = $1::uuid and login is not null and disabled_at is null`, [id])
    const stored = rows[0] === undefined ? undefined : optionalText(rows[0], 'password_hash')
    const matches = await verifyPassword(password, stored ?? await decoyHash())
    return stored !== undefined && matches
  }

  async signIn(login: string, password: string, device: { name: string; address?: string }): Promise<IssuedToken> {
    let key: string
    try {
      key = normalizeLogin(login)
    } catch {
      await verifyPassword(password, await decoyHash())
      throw new AccountError('wrong login or password', 'BAD_CREDENTIALS')
    }
    const { rows } = await this.sql.query(`select ${ACCOUNT_COLUMNS}, a.password_hash from account a where a.login = $1`, [key])
    const row = rows[0]
    const stored = row === undefined ? undefined : optionalText(row, 'password_hash')
    const matches = await verifyPassword(password, stored ?? await decoyHash())
    if (row === undefined || stored === undefined || !matches) {
      await this.sql.query(`insert into audit (actor, action, target, detail) values ($1, 'signin.failed', null, $2)`, [device.address ?? 'unknown', JSON.stringify({ login: key })])
      throw new AccountError('wrong login or password', 'BAD_CREDENTIALS')
    }
    const account = accountFrom(row)
    if (account.disabled) throw new AccountError('wrong login or password', 'BAD_CREDENTIALS')
    return this.sql.transaction(async tx => {
      const { token, device: made } = await this.newDevice(tx, account.id, 'client', device.name)
      await this.audit(tx, account.id, 'signin', made.id, device.address ? { address: device.address } : undefined)
      return { token, principal: { account, device: made } }
    })
  }

  async authenticate(token: string): Promise<Principal | undefined> {
    if (!token.startsWith(TOKEN_PREFIX) || token.length > 200) return undefined
    const { rows } = await this.sql.query(
      `select ${ACCOUNT_COLUMNS},
         d.id::text as d_id, d.account_id::text as d_account_id, d.kind as d_kind, d.name as d_name,
         d.last_seen as d_last_seen, d.revoked_at as d_revoked_at
       from device d join account a on a.id = d.account_id
       where d.token_hash = $1 and d.revoked_at is null and a.disabled_at is null and a.login is not null`,
      [sha256(token)],
    )
    const row = rows[0]
    if (row === undefined) return undefined
    const principal = { account: accountFrom(row), device: deviceFrom(row, 'd_') }
    const now = this.now()
    if (now - (this.touched.get(principal.device.id) ?? 0) >= this.touchMs) {
      this.touched.set(principal.device.id, now)
      await this.sql.query(`update device set last_seen = now() where id = $1::uuid`, [principal.device.id])
    }
    return principal
  }

  async signOut(token: string): Promise<void> {
    if (!token.startsWith(TOKEN_PREFIX)) return
    await this.sql.query(`update device set revoked_at = now() where token_hash = $1 and revoked_at is null`, [sha256(token)])
  }

  async listDevices(accountId: string): Promise<Device[]> {
    const { rows } = await this.sql.query(
      `select id::text as id, account_id::text as account_id, kind, name, last_seen, revoked_at from device
       where account_id = $1::uuid and revoked_at is null order by last_seen desc nulls last`,
      [accountId],
    )
    return rows.map(row => deviceFrom(row))
  }

  async revokeDevice(accountId: string, deviceId: string, actor?: string): Promise<boolean> {
    return this.sql.transaction(async tx => {
      const { rows } = await tx.query(
        `update device set revoked_at = now() where id = $1::uuid and account_id = $2::uuid and revoked_at is null returning id`,
        [deviceId, accountId],
      )
      if (rows.length) await this.audit(tx, actor ?? accountId, 'device.revoke', deviceId)
      return rows.length > 0
    })
  }

  async issueCode(input: IssueCodeInput): Promise<IssuedCode> {
    const role: AccountRole | undefined = input.purpose === 'invite' ? input.role ?? 'member' : undefined
    if (role !== undefined && !isAccountRole(role)) throw new AccountError(`unknown role ${String(role)}`, 'ACCOUNT_INVALID')
    if (input.purpose !== 'invite' && !input.accountId) throw new AccountError('a pairing code needs an account', 'ACCOUNT_INVALID')
    const ttl = Math.min(input.ttlMs ?? (input.purpose === 'invite' ? INVITE_TTL_MS : PAIRING_TTL_MS), MAX_CODE_TTL_MS)
    if (!(ttl > 0)) throw new AccountError('a code must live a while', 'ACCOUNT_INVALID')
    const code = formatCode(randomBytes(17))
    const expiresAt = new Date(this.now() + ttl).toISOString()
    await this.sql.transaction(async tx => {
      if (input.accountId) {
        const { rows } = await tx.query(`select id from account where id = $1::uuid and login is not null and disabled_at is null`, [input.accountId])
        if (rows.length === 0) throw new AccountError('no such account', 'ACCOUNT_NOT_FOUND')
      }
      await tx.query(
        `insert into auth_code (code_hash, purpose, account_id, role, created_by, expires_at) values ($1, $2, $3, $4, $5, $6)`,
        [sha256(normalizeCode(code)), input.purpose, input.purpose === 'invite' ? null : input.accountId, role ?? null, input.createdBy && UUID.test(input.createdBy) ? input.createdBy : null, expiresAt],
      )
      await this.audit(tx, input.createdBy, `code.${input.purpose}`, input.accountId, role ? { role } : undefined)
    })
    return { code, purpose: input.purpose, expiresAt, ...(role ? { role } : {}) }
  }

  async redeemCode(code: string, input: RedeemInput): Promise<IssuedToken> {
    // Check what the person typed before spending the code, so a taken login
    // or a short password does not burn it.
    const newAccount = input.purpose === 'invite'
      ? { login: normalizeLogin(input.login ?? ''), password: input.password ?? '', ...(input.name === undefined ? {} : { name: input.name }) }
      : undefined
    if (newAccount) assertPassword(newAccount.password)
    return this.sql.transaction(async tx => {
      const { rows } = await tx.query(
        `update auth_code set used_at = now()
         where code_hash = $1 and purpose = $2 and used_at is null and expires_at > now()
         returning account_id::text as account_id, role`,
        [sha256(normalizeCode(code)), input.purpose],
      )
      const spent = rows[0]
      if (spent === undefined) throw new AccountError('this code is not valid: it may be mistyped, used or expired', 'CODE_INVALID')
      let account: Account
      if (newAccount) {
        const role = optionalText(spent, 'role')
        if (!isAccountRole(role)) throw new AccountError('the invite has no role', 'ACCOUNTS_FAILED')
        account = await this.insertAccount(tx, { ...newAccount, role }, undefined)
      } else {
        const accountId = optionalText(spent, 'account_id')
        const { rows: found } = await tx.query(`select ${ACCOUNT_COLUMNS} from account a where a.id = $1::uuid and a.login is not null`, [accountId ?? null])
        if (found[0] === undefined) throw new AccountError('this code is not valid: it may be mistyped, used or expired', 'CODE_INVALID')
        account = accountFrom(found[0])
        if (account.disabled) throw new AccountError('this code is not valid: it may be mistyped, used or expired', 'CODE_INVALID')
      }
      const kind: DeviceKind = input.purpose === 'daemon' ? 'daemon' : 'client'
      const { token, device } = await this.newDevice(tx, account.id, kind, input.deviceName)
      await this.audit(tx, account.id, `code.redeem.${input.purpose}`, device.id)
      return { token, principal: { account, device } }
    })
  }

  /** How many people can sign in; `tnega server init` asks before it makes the first owner. */
  async countAccounts(): Promise<number> {
    const { rows } = await this.sql.query(`select count(*)::int as n from account where login is not null`)
    return int(rows[0], 'n')
  }
}
