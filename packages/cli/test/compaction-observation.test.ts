import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@tnega/core'
import { SessionLog } from '@tnega/session'
import { expect, it } from 'vitest'
import { observeCompaction } from '../src/compaction-observation.js'

it.each([false, true])('forwards only the owned checkpoint and removes its observer (resident=%s)', async resident => {
  const workspace = await mkdtemp(join(tmpdir(), 'tnega-compaction-observation-'))
  const root = new Context()
  const ctx = resident ? root.extend() : root
  const session = new SessionLog(join(workspace, 'own.jsonl'), undefined, ctx)
  const sibling = new SessionLog(join(workspace, 'sibling.jsonl'), undefined, root.extend())
  const frames: Array<Record<string, unknown>> = []
  const observer = await observeCompaction(ctx, session, event => { frames.push(event) })
  try {
    await session.append('user/message', { content: 'A long conversation' })
    await session.append('checkpoint', { messages: [{ role: 'user', content: 'Rewritten request' }] })
    await sibling.append('checkpoint', { messages: [], summary: 'Other Agent summary' })
    const checkpoint = await session.append('checkpoint', { messages: [], summary: 'Owned summary', tokensBefore: 1000 })
    await observer.dispose()
    expect(frames).toEqual([{ type: 'session/compaction', id: checkpoint.id, summary: 'Owned summary', tokensBefore: 1000 }])
    await session.append('checkpoint', { messages: [], summary: 'Later run' })
    await session.flush()
    expect(frames).toHaveLength(1)
  } finally {
    await observer.dispose()
    await Promise.all([session.close(), sibling.close()])
    await root.fiber.dispose()
    await rm(workspace, { recursive: true, force: true })
  }
})
