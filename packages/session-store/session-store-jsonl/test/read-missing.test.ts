import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readSessionMessages, SessionNotFoundError, readSessionSnapshot, sessionFile } from '../src/index.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

const UNKNOWN = '00000000-0000-4000-8000-000000000000'

it('reports a session it does not have instead of creating one', async () => {
  const workspace = await tempDir('tnega-store-missing-')
  const file = sessionFile(workspace, UNKNOWN)

  await expect(readSessionSnapshot(workspace, UNKNOWN)).rejects.toBeInstanceOf(SessionNotFoundError)
  await expect(readSessionMessages(workspace, UNKNOWN)).rejects.toBeInstanceOf(SessionNotFoundError)
  // The point of the rule: a stale link or a wrong workspace leaves no empty log behind.
  await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('still reads a session that exists', async () => {
  const workspace = await tempDir('tnega-store-present-')
  const { createSession } = await import('../src/index.js')
  const session = await createSession(workspace, { title: 'exists' })
  const snapshot = await readSessionSnapshot(workspace, session.id)
  expect(snapshot.summary.id).toBe(session.id)
  expect(await readSessionMessages(workspace, session.id)).toEqual([])
})
