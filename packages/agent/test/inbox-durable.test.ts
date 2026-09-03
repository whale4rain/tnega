import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { SessionLog } from '@tnega/session'

import { DurableInbox } from '../src/index.js'

const dirs: string[] = []

async function tempFile(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-inbox-durable-'))
  dirs.push(dir)
  return join(dir, name)
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('durable inbox', () => {
  it('persists insert, steer and claim as inbox splices', async () => {
    const file = await tempFile('inbox-events.jsonl')
    const log = new SessionLog(file)
    await log.init()
    const inbox = new DurableInbox(log)

    const normal = await inbox.insert({ text: 'queued' })
    const urgent = await inbox.steer({ text: 'urgent' })
    const claimed = await inbox.claim()

    expect(claimed?.id).toBe(urgent.id)
    expect(normal.id).not.toBe(urgent.id)
    const events = await log.read()
    const splices = events.filter(event => event.type === 'agent/inbox/spliced')
    expect(splices).toHaveLength(3)
    await log.close()
  })

  it('restores pending work from a reopened log', async () => {
    const file = await tempFile('inbox-restore.jsonl')
    const first = new SessionLog(file)
    await first.init()
    const inbox = new DurableInbox(first)
    await inbox.insert({ text: 'alpha' })
    await inbox.steer({ text: 'beta' })
    await first.flush()
    await first.close()

    const second = new SessionLog(file)
    await second.init()
    const restored = await DurableInbox.restore(second)
    expect(restored.snapshot()).toMatchObject({
      nextTurn: [{ text: 'alpha' }],
      nextStep: [{ text: 'beta' }],
    })

    const claimed = await restored.claim()
    expect(claimed?.text).toBe('beta')
    expect(restored.size).toBe(1)
    await second.close()
  })

  it('clears both queues through durable splices', async () => {
    const file = await tempFile('inbox-clear.jsonl')
    const log = new SessionLog(file)
    await log.init()
    const inbox = new DurableInbox(log)
    await inbox.insert({ text: 'one' })
    await inbox.steer({ text: 'two' })
    await inbox.clear()

    expect(inbox.size).toBe(0)
    const splices = (await log.read()).filter(event => event.type === 'agent/inbox/spliced')
    expect(splices.some(event => (event.payload.deleteCount ?? 0) === Number.POSITIVE_INFINITY)).toBe(true)
    await log.close()
  })
})
