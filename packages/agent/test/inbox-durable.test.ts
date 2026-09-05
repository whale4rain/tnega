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

  it('replaces and removes pending messages by stable id', async () => {
    const file = await tempFile('inbox-replace.jsonl')
    const log = new SessionLog(file)
    await log.init()
    const inbox = new DurableInbox(log)

    const first = await inbox.insert({ text: 'first' })
    const second = await inbox.insert({ text: 'second' })
    const replaced = await inbox.replace(first.id, { text: 'replaced' })
    expect(replaced).toBeDefined()
    expect(replaced!.id).not.toBe(first.id)
    expect(inbox.snapshot().nextTurn.map(message => message.text)).toEqual([
      'replaced',
      'second',
    ])

    const removed = await inbox.remove(second.id)
    expect(removed?.id).toBe(second.id)
    expect(inbox.snapshot().nextTurn.map(message => message.text)).toEqual(['replaced'])

    expect(inbox.get(replaced!.id)).toMatchObject({ text: 'replaced' })
    expect(inbox.get(second.id)).toBeUndefined()
    await log.close()
  })

  it('restores replaced and removed messages from durable splices', async () => {
    const file = await tempFile('inbox-replace-restore.jsonl')
    const first = new SessionLog(file)
    await first.init()
    const inbox = new DurableInbox(first)
    const alpha = await inbox.insert({ text: 'alpha' })
    const beta = await inbox.insert({ text: 'beta' })
    await inbox.replace(alpha.id, { text: 'alpha2' })
    await inbox.remove(beta.id)
    await first.flush()
    await first.close()

    const second = new SessionLog(file)
    await second.init()
    const restored = await DurableInbox.restore(second)
    expect(restored.snapshot().nextTurn.map(message => message.text)).toEqual(['alpha2'])
    await second.close()
  })

  it('inserts at an explicit queue index', async () => {
    const file = await tempFile('inbox-insert-at.jsonl')
    const log = new SessionLog(file)
    await log.init()
    const inbox = new DurableInbox(log)
    const first = await inbox.insert({ text: 'first' })
    const third = await inbox.insert({ text: 'third' })
    await inbox.insertAt({ text: 'second' }, 'next-turn', 1)

    expect(inbox.snapshot().nextTurn.map(message => message.text)).toEqual([
      'first',
      'second',
      'third',
    ])
    await inbox.insertAt({ text: 'urgent-second' }, 'next-step', 1)
    expect(inbox.snapshot().nextStep.map(message => message.text)).toEqual([
      'urgent-second',
    ])
    void first
    void third
    await log.close()
  })

  it('claims all steering plus one queued turn in one batch', async () => {
    const file = await tempFile('inbox-claim-batch.jsonl')
    const log = new SessionLog(file)
    await log.init()
    const inbox = new DurableInbox(log)
    await inbox.insert({ text: 'one' })
    await inbox.insert({ text: 'two' })
    await inbox.steer({ text: 'steer-a' })
    await inbox.steer({ text: 'steer-b' })

    const batch = await inbox.claimBatch()
    expect(batch.map(message => message.text)).toEqual([
      'steer-b',
      'steer-a',
      'one',
    ])
    expect(inbox.size).toBe(1)
    expect(inbox.snapshot().nextTurn.map(message => message.text)).toEqual(['two'])
    await log.close()
  })

  it('preserves structured content across restore', async () => {
    const file = await tempFile('inbox-structured-restore.jsonl')
    const first = new SessionLog(file)
    await first.init()
    const inbox = new DurableInbox(first)
    const messages = [
      { role: 'user' as const, content: 'from history' },
      { role: 'user' as const, content: 'followup' },
    ]
    await inbox.insert({
      text: 'text projection',
      content: messages,
    })
    await first.flush()
    await first.close()

    const second = new SessionLog(file)
    await second.init()
    const restored = await DurableInbox.restore(second)
    expect(restored.snapshot().nextTurn[0]).toMatchObject({
      text: 'text projection',
      content: messages,
    })
    await second.close()
  })
})
