import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { SessionLog, type SessionEvent } from '@tnega/session'

import {
  compactSession,
  createSession,
  forkSession,
  patchSessionMeta,
  readSessionSummary,
  sessionFile,
  setSessionTitle,
  truncateSessionAt,
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

async function readHeadLine(workspace: string, id: string): Promise<SessionEvent> {
  const text = await readFile(sessionFile(workspace, id), 'utf8')
  const first = text.split('\n').find(line => line.trim().length > 0)!
  return JSON.parse(first) as SessionEvent
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

  it('persists title changes as append-only meta/patch events', async () => {
    const workspace = await tempDir('tnega-store-title-append-')
    const summary = await createSession(workspace, { title: 'before' })

    const retitled = await setSessionTitle(workspace, summary.id, 'after')
    expect(retitled.title).toBe('after')

    const metaEvent = await readHeadLine(workspace, summary.id)
    expect(metaEvent.type).toBe('meta') // head meta is untouched, not rewritten

    // The rewrite path must not replace the head meta in place: assert the file
    // still opens as a valid SessionLog and the title comes from the appended event.
    const writer = new SessionLog(sessionFile(workspace, summary.id))
    await writer.init()
    const folded = await writer.meta()
    expect(folded.title).toBe('after')
    await writer.close()

    const reloaded = await readSessionSummary(workspace, summary.id)
    expect(reloaded.title).toBe('after')
    expect(reloaded.eventCount).toBeGreaterThan(1)
  })

  it('keeps the newest title when forking a renamed session', async () => {
    const workspace = await tempDir('tnega-store-fork-title-')
    const parent = await createSession(workspace, { title: 'before' })
    await setSessionTitle(workspace, parent.id, 'renamed')

    const fork = await forkSession(workspace, parent.id)
    expect(fork.title).toBe('renamed fork')
    expect(fork.agentType).toBeUndefined()
  })

  it('flushes compacted events before reading the summary from disk', async () => {
    const workspace = await tempDir('tnega-store-compact-flush-')
    const summary = await createSession(workspace, { title: 'compact' })
    const writer = new SessionLog(sessionFile(workspace, summary.id))
    await writer.init()
    await writer.append('user/message', { content: 'hello' })
    await writer.append('assistant/message', { content: 'world' })
    await writer.flush()

    const compacted = await compactSession(workspace, summary.id, {
      keepTokens: 1,
      summary: 'kept',
      checkpointMessages: [{ role: 'system', content: 'kept' }],
    })
    expect(compacted.eventCount).toBeGreaterThan(1)

    const reloaded = await readSessionSummary(workspace, summary.id)
    expect(reloaded.eventCount).toBeGreaterThan(1)
    await writer.close()
  })

  it('keeps the durable title when truncating to an early message', async () => {
    const workspace = await tempDir('tnega-store-truncate-meta-')
    const summary = await createSession(workspace, { title: 'first' })
    await setSessionTitle(workspace, summary.id, 'retitled')

    const writer = new SessionLog(sessionFile(workspace, summary.id))
    await writer.init()
    const target = await writer.append('user/message', { content: 'q1' })
    await writer.append('assistant/message', { content: 'a1' })
    await writer.append('user/message', { content: 'q2' })
    await writer.append('assistant/message', { content: 'a2' })
    await writer.close()

    // Truncating rolls back to just before the target message (dropping it and
    // everything after, since the UI re-issues the edited prompt).
    const result = await truncateSessionAt(workspace, summary.id, target.id)
    expect(result.title).toBe('retitled')

    const reopened = new SessionLog(sessionFile(workspace, summary.id))
    await reopened.init()
    const events = await reopened.read()
    expect(events.map(event => event.type)).toEqual(['meta', 'meta/patch'])
    expect(await reopened.meta()).toMatchObject({ title: 'retitled' })
    await reopened.close()
  })
})
