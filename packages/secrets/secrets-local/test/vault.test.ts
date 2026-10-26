import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { SecretVault, secretsLocal } from '../src/index.js'

const cleanups: string[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

async function vault() {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-secrets-'))
  cleanups.push(dir)
  return { vault: new SecretVault({ file: join(dir, 'secrets.json') }), file: join(dir, 'secrets.json'), workspace: join(dir, 'ws') }
}

describe('SecretVault', () => {
  it('keeps a session secret in memory only, for that session', async () => {
    const { vault: v, file, workspace } = await vault()
    const a = { workspace, sessionId: 'a' }
    await v.set(a, 'API_KEY', 'value-1234')
    expect(await v.list(a)).toEqual([{ name: 'API_KEY', remembered: false }])
    expect(await v.entries(a)).toEqual([{ name: 'API_KEY', value: 'value-1234' }])
    expect(await v.list({ workspace, sessionId: 'b' })).toEqual([])
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
    v.forgetSession(a)
    expect(await v.list(a)).toEqual([])
  })

  it('remembers a secret for every session of the workspace, in an owner-only file', async () => {
    const { vault: v, file, workspace } = await vault()
    await v.set({ workspace, sessionId: 'a' }, 'API_KEY', 'saved-value')
      .then(() => v.set({ workspace, sessionId: 'a' }, 'TOKEN', 'remembered-value', { remember: true }))
    expect(await v.list({ workspace, sessionId: 'b' })).toEqual([{ name: 'TOKEN', remembered: true }])
    // A fresh vault (a restarted host) still has it.
    const restarted = new SecretVault({ file })
    expect(await restarted.entries({ workspace, sessionId: 'c' })).toEqual([{ name: 'TOKEN', value: 'remembered-value' }])
    expect(await restarted.list({ workspace: join(workspace, 'other'), sessionId: 'c' })).toEqual([])
    expect(await readFile(file, 'utf8')).not.toContain('saved-value')
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it('lets a session value cover a remembered one, and remove forgets both', async () => {
    const { vault: v, workspace } = await vault()
    const a = { workspace, sessionId: 'a' }
    await v.set(a, 'TOKEN', 'saved', { remember: true })
    await v.set(a, 'TOKEN', 'mine')
    expect(await v.entries(a)).toEqual([{ name: 'TOKEN', value: 'mine' }])
    expect(await v.list(a)).toEqual([{ name: 'TOKEN', remembered: false }])
    expect(await v.remove(a, 'TOKEN')).toBe(true)
    expect(await v.list(a)).toEqual([])
    expect(await v.list({ workspace, sessionId: 'b' })).toEqual([])
    expect(await v.remove(a, 'TOKEN')).toBe(false)
  })

  it('refuses names commands rely on and empty values', async () => {
    const { vault: v, workspace } = await vault()
    await expect(v.set({ workspace, sessionId: 'a' }, 'PATH', 'x')).rejects.toMatchObject({ code: 'SECRET_INVALID' })
    await expect(v.set({ workspace, sessionId: 'a' }, 'LD_AUDIT', 'x')).rejects.toMatchObject({ code: 'SECRET_INVALID' })
    await expect(v.set({ workspace, sessionId: 'a' }, 'OK_NAME', '')).rejects.toMatchObject({ code: 'SECRET_INVALID' })
  })

  it('keeps a secret named __proto__ and does not read inherited names as stored', async () => {
    const { vault: v, file, workspace } = await vault()
    await v.set({ workspace, sessionId: 'a' }, '__proto__', 'proto-value', { remember: true })
    expect(await v.list({ workspace, sessionId: 'b' })).toEqual([{ name: '__proto__', remembered: true }])
    expect(await v.entries({ workspace, sessionId: 'b' })).toEqual([{ name: '__proto__', value: 'proto-value' }])
    // And it survives a restart, which re-reads the file.
    const restarted = new SecretVault({ file })
    expect(await restarted.entries({ workspace, sessionId: 'c' })).toEqual([{ name: '__proto__', value: 'proto-value' }])
    // `toString` was never stored: reporting a removal would be a lie.
    expect(await v.remove({ workspace, sessionId: 'a' }, 'toString')).toBe(false)
    expect(await v.list({ workspace, sessionId: 'b' })).toEqual([{ name: '__proto__', remembered: true }])
  })
})

it('mounts ctx.secrets bound to one session and unmounts it on dispose', async () => {
  const { vault: v, workspace } = await vault()
  const ctx = new Context()
  const fiber = ctx.plugin(secretsLocal, { vault: v, workspace, sessionId: 's1' })
  await fiber
  await ctx.secrets.set('API_KEY', 'value-1234')
  expect(await v.list({ workspace, sessionId: 's1' })).toEqual([{ name: 'API_KEY', remembered: false }])
  await fiber.dispose()
  expect(ctx.get('secrets', false)).toBeUndefined()
})
