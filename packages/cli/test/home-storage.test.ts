import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSession, deleteSession, listSessions, sessionFile, setSessionTitle } from '../src/store.js'
import { defaultRunSessionFile } from '../src/home-paths.js'

let root: string
const id = '11111111-1111-4111-8111-111111111111'

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tnega-home-storage-'))
  vi.stubEnv('TNEGA_HOME', join(root, 'home'))
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

describe('home session storage', () => {
  it('reports legacy writers continuing after migration instead of silently ignoring events', async () => {
    const workspace = join(root, 'workspace')
    const legacy = join(workspace, '.tnega', 'sessions', `${id}.jsonl`)
    await mkdir(dirname(legacy), { recursive: true })
    await writeFile(legacy, 'event1\n')
    const target = sessionFile(workspace, id)
    await writeFile(legacy, 'event1\nevent2\n')
    expect(() => sessionFile(workspace, id)).toThrow(/changed after migration/i)
    expect(await readFile(target, 'utf8')).toBe('event1\n')
    expect(await readFile(legacy, 'utf8')).toBe('event1\nevent2\n')
  })
  it('stores sessions outside the workspace and isolates equal workspace names', async () => {
    const left = join(root, 'left', 'project')
    const right = join(root, 'right', 'project')
    const created = await createSession(left, { title: 'left' })
    expect(sessionFile(left, created.id)).toMatch(new RegExp(`home[\\\\/]sessions[\\\\/][a-f0-9]{64}[\\\\/]`))
    expect(await listSessions(right)).toEqual([])
    await expect(readFile(join(left, '.tnega', 'sessions', `${created.id}.jsonl`))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('imports legacy sessions before direct reads and keeps the source unchanged', async () => {
    const workspace = join(root, 'workspace')
    const legacy = join(workspace, '.tnega', 'sessions', `${id}.jsonl`)
    await mkdir(join(workspace, '.tnega', 'sessions'), { recursive: true })
    // Use the current writer for a valid header rather than freezing a format version.
    const created = await createSession(join(root, 'seed'), { title: 'legacy' })
    const contents = await readFile(sessionFile(join(root, 'seed'), created.id), 'utf8')
    await writeFile(legacy, contents.replaceAll(created.id, id))
    await utimes(legacy, new Date('2020-01-01'), new Date('2020-01-01'))
    const source = await readFile(legacy, 'utf8')
    expect(await readFile(sessionFile(workspace, id), 'utf8')).toBe(source)
    expect((await stat(sessionFile(workspace, id))).mtimeMs).toBe((await stat(legacy)).mtimeMs)
    await setSessionTitle(workspace, id, 'continued')
    expect(await readFile(legacy, 'utf8')).toBe(source)
    expect((await listSessions(workspace))[0]?.title).toBe('continued')
    await deleteSession(workspace, id)
    expect(await listSessions(workspace)).toEqual([])
  })

  it('refuses a conflicting home file without overwriting either copy', async () => {
    const workspace = join(root, 'workspace')
    const target = sessionFile(workspace, id)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, 'home\n')
    const legacy = join(workspace, '.tnega', 'sessions', `${id}.jsonl`)
    await mkdir(join(workspace, '.tnega', 'sessions'), { recursive: true })
    await writeFile(legacy, 'legacy\n')
    expect(() => sessionFile(workspace, id)).toThrow(/conflict/i)
    expect(await readFile(target, 'utf8')).toBe('home\n')
    expect(await readFile(legacy, 'utf8')).toBe('legacy\n')
  })

  it('imports the CLI run log once and continues in home storage', async () => {
    const workspace = join(root, 'workspace')
    const legacy = join(workspace, '.tnega', 'run-v10.jsonl')
    await mkdir(dirname(legacy), { recursive: true })
    await writeFile(legacy, 'legacy run\n')
    await writeFile(join(dirname(legacy), 'run-v9.jsonl'), 'older run\n')
    const target = defaultRunSessionFile(workspace, 10)
    expect(await readFile(target, 'utf8')).toBe('legacy run\n')
    expect(await readFile(join(dirname(target), 'run-v9.jsonl'), 'utf8')).toBe('older run\n')
    await writeFile(target, 'continued run\n')
    expect(defaultRunSessionFile(workspace, 10)).toBe(target)
    expect(await readFile(target, 'utf8')).toBe('continued run\n')
    expect(await readFile(legacy, 'utf8')).toBe('legacy run\n')
  })
})
