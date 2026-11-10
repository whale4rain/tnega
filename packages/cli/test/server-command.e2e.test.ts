import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CliError } from '../src/commands.js'
import { runServerCommand, type ServerIo } from '../src/server-command.js'

/**
 * Host layer: `tnega server` against a real Postgres. Point
 * TNEGA_TEST_DATABASE_URL at a database this test may fill; it works in a
 * schema of its own and drops it afterwards.
 */
const url = process.env.TNEGA_TEST_DATABASE_URL
const schema = `tnega_cli_${randomUUID().replaceAll('-', '')}`
const urlWithSchema = url ? `${url}${url.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}` : ''

function io(password = ''): ServerIo & { written: string } {
  const sink = {
    written: '',
    out(text: string) { sink.written += text },
    err(text: string) { sink.written += text },
    ask: () => Promise.reject(new CliError('no terminal')),
    stdin: () => Promise.resolve(`${password}\n`),
  }
  return sink
}

describe.skipIf(!url)('tnega server on a real database', () => {
  let admin: pg.Client
  let dir: string
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url })
    await admin.connect()
    await admin.query(`create schema ${schema}`)
    dir = await mkdtemp(join(tmpdir(), 'tnega-server-e2e-'))
  })
  afterAll(async () => {
    await admin.query(`drop schema if exists ${schema} cascade`)
    await admin.end()
    await rm(dir, { recursive: true, force: true })
  })

  it('initialises once, prints the owner invite, then manages people', async () => {
    const first = io()
    expect(await runServerCommand(['init', '--dir', dir, '--database-url', urlWithSchema, '--public-url', 'https://tnega.example.com'], first, {})).toBe(0)
    expect(first.written).toMatch(/https:\/\/tnega\.example\.com\/\?invite=[0-9A-Z-]+/u)
    const settings = await readFile(join(dir, 'server.env'), 'utf8')
    const key = /TNEGA_MASTER_KEY=(.+)/u.exec(settings)?.[1]
    // A second init keeps the master key.
    await runServerCommand(['init', '--dir', dir], io(), {})
    expect(/TNEGA_MASTER_KEY=(.+)/u.exec(await readFile(join(dir, 'server.env'), 'utf8'))?.[1]).toBe(key)

    expect(await runServerCommand(['user', 'add', 'ocean', '--role', 'owner', '--password-stdin', '--dir', dir], io('a long owner password'), {})).toBe(0)
    expect(await runServerCommand(['user', 'add', 'mia', '--password-stdin', '--dir', dir], io('a long member password'), {})).toBe(0)
    const list = io()
    await runServerCommand(['user', 'list', '--dir', dir], list, {})
    expect(list.written).toMatch(/mia\s+member\s+active/u)
    expect(list.written).toMatch(/ocean\s+owner\s+active/u)
    const after = io()
    await runServerCommand(['init', '--dir', dir], after, {})
    expect(after.written).toContain('has 2 account(s)')

    await runServerCommand(['user', 'set', 'mia', '--disable', '--dir', dir], io(), {})
    const disabled = io()
    await runServerCommand(['user', 'list', '--dir', dir], disabled, {})
    expect(disabled.written).toMatch(/mia\s+member\s+disabled/u)
    await expect(runServerCommand(['user', 'set', 'ocean', '--role', 'member', '--dir', dir], io(), {})).rejects.toThrow(/at least one owner/)

    const invite = io()
    await runServerCommand(['invite', '--role', 'admin', '--days', '1', '--dir', dir], invite, {})
    expect(invite.written).toMatch(/Invite for a new admin/u)
    const pair = io()
    await runServerCommand(['pair', 'ocean', '--daemon', '--dir', dir], pair, {})
    expect(pair.written).toMatch(/ocean's daemon/u)
  })
})
