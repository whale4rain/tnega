import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SecretVault } from '@tnega/secrets-local'
import { bootstrapSecretTables, masterKeyId, parseMasterKey, PgRememberedSecrets } from '../src/index.js'

const ACCOUNT = '7e9a0000-0000-4000-8000-000000000001'
let db: PGlite

beforeAll(async () => {
  db = new PGlite()
  await bootstrapSecretTables(db, ACCOUNT)
  // Twice: a database that has the tables already is left as it is.
  await bootstrapSecretTables(db, ACCOUNT)
})
afterAll(async () => { await db.close() })

function store(key = randomBytes(32)) {
  return { key, secrets: new PgRememberedSecrets({ sql: db, masterKey: key, accountId: ACCOUNT }) }
}

const workspace = () => join(tmpdir(), `tnega-secrets-pg-${randomBytes(4).toString('hex')}`)

describe('remembered secrets on Postgres', () => {
  it('reads back what it saved, per workspace, and never holds a value in the clear', async () => {
    const { secrets } = store()
    const here = workspace()
    await secrets.set(here, 'GITHUB_TOKEN', 'ghp_clear_text_value')
    await secrets.set(workspace(), 'GITHUB_TOKEN', 'another-workspace')
    expect(await secrets.read(here)).toEqual({ GITHUB_TOKEN: 'ghp_clear_text_value' })
    const { rows } = await db.query<{ dump: string }>(`select string_agg(encode(ciphertext, 'escape') || name, '') as dump from secret`)
    expect(rows[0]?.dump).not.toContain('ghp_clear_text_value')
    await secrets.set(here, 'GITHUB_TOKEN', 'replaced')
    expect(await secrets.read(here)).toEqual({ GITHUB_TOKEN: 'replaced' })
    expect(await secrets.remove(here, 'GITHUB_TOKEN')).toBe(true)
    expect(await secrets.remove(here, 'GITHUB_TOKEN')).toBe(false)
    expect(await secrets.read(here)).toEqual({})
  })

  it('refuses to open rows sealed under another master key, and says so', async () => {
    const here = workspace()
    await store().secrets.set(here, 'API_KEY', 'value-1234')
    await expect(store().secrets.read(here)).rejects.toMatchObject({ code: 'SECRET_FAILED', message: expect.stringMatching(/another master key/) })
  })

  it('does not open a sealed value copied onto another row', async () => {
    const { secrets } = store()
    const here = workspace()
    await secrets.set(here, 'FIRST_KEY', 'first-value')
    await secrets.set(here, 'SECOND_KEY', 'second-value')
    await db.query(`update secret set ciphertext = (select ciphertext from secret where name like '%/FIRST_KEY' and account_id = $1 limit 1) where name like '%/SECOND_KEY'`, [ACCOUNT])
    await expect(secrets.read(here)).rejects.toMatchObject({ code: 'SECRET_FAILED', message: expect.stringMatching(/does not open/) })
  })

  it('backs the host vault: remembered secrets survive a new vault, session ones do not', async () => {
    const key = randomBytes(32)
    const scope = { workspace: workspace(), sessionId: 's1' }
    const first = new SecretVault({ remembered: new PgRememberedSecrets({ sql: db, masterKey: key, accountId: ACCOUNT }) })
    await first.set(scope, 'REMEMBERED_KEY', 'kept-value', { remember: true })
    await first.set(scope, 'SESSION_KEY', 'gone-value')
    const second = new SecretVault({ remembered: new PgRememberedSecrets({ sql: db, masterKey: key, accountId: ACCOUNT }) })
    expect(await second.entries(scope)).toEqual([{ name: 'REMEMBERED_KEY', value: 'kept-value' }])
    expect(second.file).toBeUndefined()
  })

  it('takes a master key as base64 or hex, and nothing shorter or looser', () => {
    const key = randomBytes(32)
    expect(parseMasterKey(key.toString('base64'))).toEqual(key)
    expect(parseMasterKey(key.toString('hex'))).toEqual(key)
    expect(masterKeyId(key)).toMatch(/^[0-9a-f]{16}$/)
    expect(() => parseMasterKey(undefined)).toThrow(/32 bytes/)
    expect(() => parseMasterKey(randomBytes(16).toString('base64'))).toThrow(/32 bytes/)
    expect(() => parseMasterKey('not a key at all')).toThrow(/32 bytes/)
  })
})
