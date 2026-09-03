import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { SessionLog } from '@tnega/session'

import {
  compactSession,
  createSession,
  forkSession,
  patchSessionMeta,
  readSessionSummary,
  sessionFile,
} from '../src/store.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

describe('session metadata', () => {
  it('persists agentType and mode on create and returns them in summaries', async () => {
    const workspace = await tempDir('tnega-store-meta-')
    const summary = await createSession(workspace, {
      title: 'coding task',
      agentType: 'coding',
      mode: 'plan',
    })

    expect(summary).toMatchObject({
      title: 'coding task',
      agentType: 'coding',
      mode: 'plan',
    })

    const reloaded = await readSessionSummary(workspace, summary.id)
    expect(reloaded).toMatchObject({
      agentType: 'coding',
      mode: 'plan',
    })
  })

  it('omits optional metadata when not provided', async () => {
    const workspace = await tempDir('tnega-store-plain-')
    const summary = await createSession(workspace, { title: 'plain' })

    expect(summary.agentType).toBeUndefined()
    expect(summary.mode).toBeUndefined()
    expect('agentType' in summary).toBe(false)
    expect('mode' in summary).toBe(false)
  })

  it('patches mode, agentType and title independently', async () => {
    const workspace = await tempDir('tnega-store-patch-')
    const summary = await createSession(workspace, {
      title: 'before',
      agentType: 'general',
      mode: 'auto',
    })

    const patched = await patchSessionMeta(workspace, summary.id, {
      mode: 'execute',
    })
    expect(patched).toMatchObject({
      title: 'before',
      agentType: 'general',
      mode: 'execute',
    })

    const retitled = await patchSessionMeta(workspace, summary.id, {
      title: 'after',
      agentType: 'coding',
    })
    expect(retitled).toMatchObject({
      title: 'after',
      agentType: 'coding',
      mode: 'execute',
    })

    const reloaded = await readSessionSummary(workspace, summary.id)
    expect(reloaded).toMatchObject({
      title: 'after',
      agentType: 'coding',
      mode: 'execute',
    })
  })

  it('inherits agentType and mode when forking', async () => {
    const workspace = await tempDir('tnega-store-fork-meta-')
    const parent = await createSession(workspace, {
      title: 'parent coding',
      agentType: 'coding',
      mode: 'plan',
    })

    const fork = await forkSession(workspace, parent.id)
    expect(fork).toMatchObject({
      parentSessionId: parent.id,
      agentType: 'coding',
      mode: 'plan',
    })
  })

  it('flushes compacted events before reading the summary from disk', async () => {
    const workspace = await tempDir('tnega-store-compact-flush-')
    const summary = await createSession(workspace, { title: 'compact' })
    const writer = new SessionLog(sessionFile(workspace, summary.id))
    await writer.init()
    await writer.append('user/message', { content: 'hello' })
    await writer.append('assistant/message', { content: 'world' })

    const compacted = await compactSession(workspace, summary.id, {
      keep: 0,
      summary: 'kept',
    })
    expect(compacted.eventCount).toBeGreaterThan(1)

    const reloaded = await readSessionSummary(workspace, summary.id)
    expect(reloaded.eventCount).toBeGreaterThan(1)
    await writer.close()
  })
})
