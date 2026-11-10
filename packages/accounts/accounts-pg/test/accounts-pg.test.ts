import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { AccountError, normalizeCode, type AccountService } from '@tnega/accounts'
import { accountsPg, hashPassword, verifyPassword } from '../src/index.js'

let db: PGlite
let accounts: AccountService
let ctx: Context

beforeAll(async () => {
  db = new PGlite()
  ctx = new Context()
  await ctx.plugin(accountsPg, { sql: db })
  // A second mount on the same database finds its tables and changes nothing.
  await new Context().plugin(accountsPg, { sql: db })
  accounts = ctx.get('accounts')
})
afterAll(async () => {
  await ctx.fiber.dispose()
  await db.close()
})

let counter = 0
const login = () => `person${++counter}`
const PASSWORD = 'correct horse battery'

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
    return undefined
  } catch (error) {
    if (error instanceof AccountError) return error.code
    throw error
  }
}

describe('passwords', () => {
  it('verifies the right password only, and never stores it in the clear', async () => {
    const hash = await hashPassword(PASSWORD)
    expect(hash).not.toContain(PASSWORD)
    expect(await verifyPassword(PASSWORD, hash)).toBe(true)
    expect(await verifyPassword('correct horse battery!', hash)).toBe(false)
    expect(await verifyPassword(PASSWORD, 'not a hash')).toBe(false)
  })
})

describe('accounts on Postgres', () => {
  it('signs a person in, knows them by token, and signs the device out', async () => {
    const name = login()
    const created = await accounts.createAccount({ login: ` ${name.toUpperCase()} `, name: 'Ada  Lovelace', role: 'member', password: PASSWORD })
    expect(created).toMatchObject({ login: name, name: 'Ada Lovelace', role: 'member', disabled: false })
    const { token, principal } = await accounts.signIn(name, PASSWORD, { name: 'Firefox' })
    expect(token.startsWith('tnk_')).toBe(true)
    expect(principal.account.id).toBe(created.id)
    expect((await accounts.authenticate(token))?.device).toMatchObject({ id: principal.device.id, kind: 'client', name: 'Firefox' })
    const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from device where token_hash::text like $1`, [`%${token}%`])
    expect(rows[0]?.n).toBe(0)
    await accounts.signOut(token)
    expect(await accounts.authenticate(token)).toBeUndefined()
  })

  it('refuses a wrong password, an unknown login and a disabled account the same way', async () => {
    const name = login()
    const account = await accounts.createAccount({ login: name, role: 'member', password: PASSWORD })
    expect(await codeOf(accounts.signIn(name, 'wrong password!', { name: 'x' }))).toBe('BAD_CREDENTIALS')
    expect(await codeOf(accounts.signIn('nobody-here', PASSWORD, { name: 'x' }))).toBe('BAD_CREDENTIALS')
    expect(await codeOf(accounts.signIn('!!', PASSWORD, { name: 'x' }))).toBe('BAD_CREDENTIALS')
    const { token } = await accounts.signIn(name, PASSWORD, { name: 'x' })
    await accounts.updateAccount(account.id, { disabled: true })
    expect(await accounts.authenticate(token)).toBeUndefined()
    expect(await codeOf(accounts.signIn(name, PASSWORD, { name: 'x' }))).toBe('BAD_CREDENTIALS')
    // Enabling again does not bring the old device back.
    await accounts.updateAccount(account.id, { disabled: false })
    expect(await accounts.authenticate(token)).toBeUndefined()
    expect(await codeOf(accounts.signIn(name, PASSWORD, { name: 'x' }))).toBeUndefined()
  })

  it('refuses a taken login, a short password and a bad login', async () => {
    const name = login()
    await accounts.createAccount({ login: name, role: 'member', password: PASSWORD })
    expect(await codeOf(accounts.createAccount({ login: name.toUpperCase(), role: 'member', password: PASSWORD }))).toBe('ACCOUNT_EXISTS')
    expect(await codeOf(accounts.createAccount({ login: login(), role: 'member', password: 'short' }))).toBe('ACCOUNT_INVALID')
    expect(await codeOf(accounts.createAccount({ login: 'has space', role: 'member', password: PASSWORD }))).toBe('ACCOUNT_INVALID')
  })

  it('keeps one owner who can sign in', async () => {
    const owners = (await accounts.listAccounts()).filter(account => account.role === 'owner' && !account.disabled)
    for (const owner of owners) await accounts.updateAccount(owner.id, { role: 'admin' }).catch(() => undefined)
    const first = await accounts.createAccount({ login: login(), role: 'owner', password: PASSWORD })
    const left = (await accounts.listAccounts()).filter(account => account.role === 'owner' && !account.disabled && account.id !== first.id)
    for (const owner of left) await accounts.updateAccount(owner.id, { role: 'admin' })
    expect(await codeOf(accounts.updateAccount(first.id, { role: 'member' }))).toBe('LAST_OWNER')
    expect(await codeOf(accounts.updateAccount(first.id, { disabled: true }))).toBe('LAST_OWNER')
    const second = await accounts.createAccount({ login: login(), role: 'owner', password: PASSWORD })
    expect((await accounts.updateAccount(first.id, { role: 'admin' })).role).toBe('admin')
    expect(await codeOf(accounts.updateAccount(second.id, { disabled: true }))).toBe('LAST_OWNER')
  })

  it('signs other devices out when the password changes', async () => {
    const name = login()
    const account = await accounts.createAccount({ login: name, role: 'member', password: PASSWORD })
    const kept = await accounts.signIn(name, PASSWORD, { name: 'kept' })
    const other = await accounts.signIn(name, PASSWORD, { name: 'other' })
    await accounts.setPassword(account.id, 'a brand new password', { keepDevice: kept.principal.device.id })
    expect(await accounts.authenticate(kept.token)).toBeDefined()
    expect(await accounts.authenticate(other.token)).toBeUndefined()
    expect(await codeOf(accounts.signIn(name, PASSWORD, { name: 'x' }))).toBe('BAD_CREDENTIALS')
    expect(await codeOf(accounts.signIn(name, 'a brand new password', { name: 'x' }))).toBeUndefined()
  })

  it('pairs a daemon with a code once, and refuses it for another purpose', async () => {
    const name = login()
    const account = await accounts.createAccount({ login: name, role: 'member', password: PASSWORD })
    const issued = await accounts.issueCode({ purpose: 'daemon', accountId: account.id, createdBy: 'cli' })
    expect(issued.code).toMatch(/^([0-9A-Z]{5}-){4}[0-9A-Z]{6}$/u)
    expect(await codeOf(accounts.redeemCode(issued.code, { purpose: 'client', deviceName: 'laptop' }))).toBe('CODE_INVALID')
    // Typed loosely: lower case, spaces for dashes.
    const typed = issued.code.toLowerCase().replaceAll('-', ' ')
    const { token, principal } = await accounts.redeemCode(typed, { purpose: 'daemon', deviceName: 'laptop' })
    expect(principal.device.kind).toBe('daemon')
    expect((await accounts.authenticate(token))?.account.id).toBe(account.id)
    expect(await codeOf(accounts.redeemCode(issued.code, { purpose: 'daemon', deviceName: 'again' }))).toBe('CODE_INVALID')
    expect((await accounts.listDevices(account.id)).map(device => device.name)).toContain('laptop')
    expect(await accounts.revokeDevice(account.id, principal.device.id)).toBe(true)
    expect(await accounts.authenticate(token)).toBeUndefined()
  })

  it('refuses an expired code', async () => {
    const account = await accounts.createAccount({ login: login(), role: 'member', password: PASSWORD })
    const issued = await accounts.issueCode({ purpose: 'client', accountId: account.id })
    await db.query(`update auth_code set expires_at = now() - interval '1 second' where code_hash = sha256(convert_to($1, 'UTF8'))`, [normalizeCode(issued.code)])
    expect(await codeOf(accounts.redeemCode(issued.code, { purpose: 'client', deviceName: 'late' }))).toBe('CODE_INVALID')
  })

  it('creates an account from an invite, with the invite role, and keeps the invite on a bad form', async () => {
    const issued = await accounts.issueCode({ purpose: 'invite', role: 'admin' })
    expect(issued.role).toBe('admin')
    const name = login()
    expect(await codeOf(accounts.redeemCode(issued.code, { purpose: 'invite', deviceName: 'web', login: name, password: 'short' }))).toBe('ACCOUNT_INVALID')
    const taken = login()
    await accounts.createAccount({ login: taken, role: 'member', password: PASSWORD })
    expect(await codeOf(accounts.redeemCode(issued.code, { purpose: 'invite', deviceName: 'web', login: taken, password: PASSWORD }))).toBe('ACCOUNT_EXISTS')
    const { principal } = await accounts.redeemCode(issued.code, { purpose: 'invite', deviceName: 'web', login: name, name: 'Grace', password: PASSWORD })
    expect(principal.account).toMatchObject({ login: name, name: 'Grace', role: 'admin' })
    expect(await codeOf(accounts.redeemCode(issued.code, { purpose: 'invite', deviceName: 'web', login: login(), password: PASSWORD }))).toBe('CODE_INVALID')
  })

  it('finds an account by id or login and lists people only', async () => {
    const name = login()
    const account = await accounts.createAccount({ login: name, role: 'member', password: PASSWORD })
    expect((await accounts.findAccount(account.id))?.login).toBe(name)
    expect((await accounts.findAccount(name.toUpperCase()))?.id).toBe(account.id)
    expect(await accounts.findAccount('missing-person')).toBeUndefined()
    // The Session store's local account has no login and is never listed.
    await db.query(`insert into account (id, name) values ('7e9a0000-0000-4000-8000-000000000001', 'local') on conflict do nothing`)
    expect((await accounts.listAccounts()).every(entry => entry.login)).toBe(true)
  })
})
