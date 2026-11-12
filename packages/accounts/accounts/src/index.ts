import { Service, type Context } from '@tnega/core'

declare module '@tnega/core' {
  interface ServiceMap {
    accounts: AccountService
  }
}

/**
 * `@tnega/accounts`: the people who may use a tnega server, the devices they
 * signed in from, and the codes that let a new person or device in
 * (`docs/plans/v2-server-mvp.md` §4.6).
 *
 * - An **account** is one person: a login, a role and a password.
 * - A **device** is one signed-in client (a browser, the TUI, the desktop app)
 *   or one daemon. It holds a random token; the store keeps only its hash.
 * - A **code** is single-use and short-lived: a pairing code gives a device a
 *   token for an existing account, an invite code creates a new account.
 *
 * Local mode mounts no Provider and needs no sign-in. Who may do what to whom
 * is {@link mayManage}; the Provider keeps the invariants (one owner at least,
 * disabled accounts sign nobody in).
 */

export const ACCOUNT_ROLES = ['owner', 'admin', 'member'] as const
export type AccountRole = typeof ACCOUNT_ROLES[number]

export function isAccountRole(value: unknown): value is AccountRole {
  return typeof value === 'string' && (ACCOUNT_ROLES as readonly string[]).includes(value)
}

export interface Account {
  id: string
  /** Lower-case, what the person types to sign in. */
  login: string
  /** Shown in the interface; the login when none was given. */
  name: string
  role: AccountRole
  disabled: boolean
  createdAt: string
}

export type DeviceKind = 'client' | 'daemon'

export interface Device {
  id: string
  accountId: string
  kind: DeviceKind
  name: string
  lastSeen?: string
  revoked: boolean
}

/** Who a request comes from. */
export interface Principal {
  account: Account
  device: Device
}

/** `client` and `daemon` pair a device with an account; `invite` creates an account. */
export type CodePurpose = 'client' | 'daemon' | 'invite'

export interface IssuedCode {
  /** Shown once; the store keeps only its hash. */
  code: string
  purpose: CodePurpose
  expiresAt: string
  /** The role an invite gives. */
  role?: AccountRole
}

export interface IssuedToken {
  /** Shown once; the store keeps only its hash. */
  token: string
  principal: Principal
}

export interface NewAccount {
  login: string
  name?: string
  role: AccountRole
  password: string
}

export interface AccountPatch {
  name?: string
  role?: AccountRole
  disabled?: boolean
}

export interface IssueCodeInput {
  purpose: CodePurpose
  /** The account a pairing code signs in to; not used for an invite. */
  accountId?: string
  /** The role an invite gives; default `member`. */
  role?: AccountRole
  ttlMs?: number
  /** The account that asked for it, for the audit log. */
  createdBy?: string
}

export interface RedeemInput {
  /** The purpose the caller expects; a code issued for another purpose is refused. */
  purpose: CodePurpose
  deviceName: string
  /** An invite's new account. */
  login?: string
  name?: string
  password?: string
}

export type AccountErrorCode =
  /** A login, name, password or role is not acceptable. */
  | 'ACCOUNT_INVALID'
  /** Wrong login or password, or a disabled account. Never says which. */
  | 'BAD_CREDENTIALS'
  /** The code is unknown, used, expired, or for another purpose. Never says which. */
  | 'CODE_INVALID'
  | 'ACCOUNT_EXISTS'
  | 'ACCOUNT_NOT_FOUND'
  /** The change would leave no owner who can sign in. */
  | 'LAST_OWNER'
  /** The caller's role does not allow it. */
  | 'FORBIDDEN'
  /** The store failed. */
  | 'ACCOUNTS_FAILED'

export class AccountError extends Error {
  override name = 'AccountError'
  constructor(message: string, readonly code: AccountErrorCode, options?: ErrorOptions) {
    super(message, options)
  }
}

const LOGIN = /^[a-z0-9][a-z0-9._-]{1,31}$/u

/** A login as stored: trimmed and lower-case, 2–32 of `a-z 0-9 . _ -`. */
export function normalizeLogin(login: string): string {
  const value = login.trim().toLowerCase()
  if (!LOGIN.test(value)) {
    throw new AccountError('A login is 2 to 32 characters: letters, digits, dot, dash or underscore, starting with a letter or digit', 'ACCOUNT_INVALID')
  }
  return value
}

export const MIN_PASSWORD_LENGTH = 10
export const MAX_PASSWORD_LENGTH = 256

export function assertPassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) throw new AccountError(`A password needs at least ${MIN_PASSWORD_LENGTH} characters`, 'ACCOUNT_INVALID')
  if (password.length > MAX_PASSWORD_LENGTH) throw new AccountError(`A password has at most ${MAX_PASSWORD_LENGTH} characters`, 'ACCOUNT_INVALID')
}

export function normalizeName(name: string | undefined, login: string): string {
  const value = (name ?? '').replace(/\s+/gu, ' ').trim()
  if (value.length > 80) throw new AccountError('A name has at most 80 characters', 'ACCOUNT_INVALID')
  return value || login
}

/** Pairing codes live ten minutes (§4.6). */
export const PAIRING_TTL_MS = 10 * 60_000
/** Invites live three days: they go out by message and wait to be read. */
export const INVITE_TTL_MS = 3 * 24 * 60 * 60_000
export const MAX_CODE_TTL_MS = 30 * 24 * 60 * 60_000

const RANK: Record<AccountRole, number> = { owner: 3, admin: 2, member: 1 }

/**
 * Whether `actor` may create, change or invite an account of role `target`
 * (and, when changing a role, of role `next`). An owner manages everyone; an
 * admin manages members only and cannot hand out admin or owner; a member
 * manages nobody.
 */
export function mayManage(actor: AccountRole, target: AccountRole, next: AccountRole = target): boolean {
  if (actor === 'owner') return true
  if (actor !== 'admin') return false
  return RANK[target] < RANK.admin && RANK[next] < RANK.admin
}

/** Owners and admins run the host: its settings, plugins, terminals and every workspace. */
export function runsHost(role: AccountRole): boolean {
  return role === 'owner' || role === 'admin'
}

/** Device tokens: `tnk_` and 32 random bytes (base64url). */
export const TOKEN_PREFIX = 'tnk_'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** A code as people type it: 26 Crockford base32 characters (130 bits), as four groups of five and one of six. */
export function formatCode(bytes: Uint8Array): string {
  if (bytes.length < 17) throw new RangeError('a code needs at least 17 random bytes')
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5 && out.length < 26) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
    value &= (1 << bits) - 1
  }
  return [0, 5, 10, 15, 20].map(at => out.slice(at, at === 20 ? 26 : at + 5)).join('-')
}

/** Undo the typing: upper-case, no dashes or spaces, and the letters Crockford reads as digits. */
export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/gu, '').replace(/[IL]/gu, '1').replace(/O/gu, '0')
}

/**
 * The accounts of one server. Provider: `@tnega/accounts-pg`. Consumers:
 * `@tnega/accounts-routes` (sign-in and the HTTP guard) and `tnega server`.
 */
export abstract class AccountService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'accounts')
  }

  abstract createAccount(input: NewAccount, createdBy?: string): Promise<Account>
  abstract listAccounts(): Promise<Account[]>
  /** By id or by login. */
  abstract findAccount(idOrLogin: string): Promise<Account | undefined>
  /** Disabling also signs every device of the account out. */
  abstract updateAccount(id: string, patch: AccountPatch, actor?: string): Promise<Account>
  /** Signs every device of the account out except `keepDevice`. */
  abstract setPassword(id: string, password: string, options?: { keepDevice?: string; actor?: string }): Promise<void>

  /** Whether this is the account's password (asked again before it is changed). */
  abstract checkPassword(id: string, password: string): Promise<boolean>
  /** A new client device for a login and password. */
  abstract signIn(login: string, password: string, device: { name: string; address?: string }): Promise<IssuedToken>
  /** The principal behind a token, or nothing for an unknown, revoked or disabled one. */
  abstract authenticate(token: string): Promise<Principal | undefined>
  abstract signOut(token: string): Promise<void>
  abstract listDevices(accountId: string): Promise<Device[]>
  abstract revokeDevice(accountId: string, deviceId: string, actor?: string): Promise<boolean>
  /**
   * A new device for an account without a code: the server minting a box's
   * daemon token. Revoke it with {@link revokeDevice} when the box goes.
   */
  abstract createDevice(accountId: string, input: { kind: DeviceKind; name: string }, actor?: string): Promise<IssuedToken>

  abstract issueCode(input: IssueCodeInput): Promise<IssuedCode>
  /** Spend a code: a pairing code gives a device, an invite an account and its first device. */
  abstract redeemCode(code: string, input: RedeemInput): Promise<IssuedToken>
}

export const name = '@tnega/accounts'
