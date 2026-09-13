import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SessionLog, type SessionEvent } from '@tnega/session'

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
  it('serializes steering before a concurrent next-step claim without duplicate input', async () => {
    const log = new SessionLog(await tempFile('steer-claim-race.jsonl'))
    await log.init()
    const inbox = new DurableInbox(log)
    await inbox.steer({ text: 'A' })

    const steering = inbox.steer({ text: 'B' })
    const claiming = inbox.claimNextStep()
    await steering
    expect((await claiming).map(message => message.text)).toEqual(['A', 'B'])
    expect(await inbox.claimNextStep()).toEqual([])
    expect((await DurableInbox.restore(log)).snapshot()).toEqual({ nextTurn: [], nextStep: [] })
    await log.close()
  })

  it('serializes replacement before a concurrent claim without claiming stale input', async () => {
    const log = new SessionLog(await tempFile('replace-claim-race.jsonl'))
    await log.init()
    const inbox = new DurableInbox(log)
    const first = await inbox.steer({ text: 'old' })

    const replacing = inbox.replace(first.id, { text: 'replacement' })
    const claiming = inbox.claimNextStep()
    const replacement = await replacing
    expect(await claiming).toEqual([replacement])
    expect(await inbox.claimNextStep()).toEqual([])
    expect((await DurableInbox.restore(log)).snapshot()).toEqual({ nextTurn: [], nextStep: [] })
    await log.close()
  })

  it('keeps both queues when a mixed claim append fails and retries each input once', async () => {
    const file = await tempFile('mixed-claim-failure.jsonl')
    const log = new SessionLog(file)
    await log.init()
    const inbox = new DurableInbox(log)
    await inbox.insert({ text: 'turn' })
    await inbox.steer({ text: 'step' })
    const before = await log.read()
    const append = log.append.bind(log)
    const failure = vi.spyOn(log, 'append').mockImplementation(async (
      type: SessionEvent['type'], payload: SessionEvent['payload'],
    ) => {
      if (type !== 'agent/inbox/spliced' || !('target' in payload)) throw new Error('unexpected append')
      // Reject the turn removal, whether committed separately or atomically.
      if (payload.target === 'next-turn' || payload.target === 'all') throw new Error('claim append failed')
      if (payload.target === 'next-step' && typeof payload.index === 'number' && typeof payload.deleteCount === 'number') {
        return append('agent/inbox/spliced', {
          target: 'next-step', index: payload.index, deleteCount: payload.deleteCount,
        })
      }
      throw new Error('unexpected splice')
    })

    await expect(inbox.claimBatch()).rejects.toThrow('claim append failed')
    expect(inbox.snapshot()).toMatchObject({ nextTurn: [{ text: 'turn' }], nextStep: [{ text: 'step' }] })
    expect(await log.read()).toEqual(before)
    expect(await log.deriveMessages()).toEqual([])
    failure.mockRestore()
    // A rejected operation must not poison the serial tail.
    await inbox.insert({ text: 'later turn' })
    await log.close()

    const reopened = new SessionLog(file)
    await reopened.init()
    const restored = await DurableInbox.restore(reopened)
    expect((await restored.claimBatch()).map(message => message.text)).toEqual(['step', 'turn'])
    expect((await restored.claimBatch()).map(message => message.text)).toEqual(['later turn'])
    expect(await restored.claimBatch()).toEqual([])
    await reopened.close()
  })

  it('does not resurrect input when replacement follows a concurrent claim', async () => {
    const log = new SessionLog(await tempFile('claim-replace-race.jsonl'))
    await log.init()
    const inbox = new DurableInbox(log)
    const first = await inbox.insert({ text: 'claimed' })
    const claiming = inbox.claim()
    const replacing = inbox.replace(first.id, { text: 'resurrected' })
    expect(await claiming).toEqual(first)
    expect(await replacing).toBeUndefined()
    expect(await inbox.claimBatch()).toEqual([])
    expect((await DurableInbox.restore(log)).size).toBe(0)
    await log.close()
  })

  it('preserves an insertion ordered after a concurrent clear', async () => {
    const log = new SessionLog(await tempFile('clear-insert-race.jsonl'))
    await log.init()
    const inbox = new DurableInbox(log)
    await inbox.insert({ text: 'old' })
    const clearing = inbox.clear()
    const inserting = inbox.insertAt({ text: 'new' }, 'next-turn', 1)
    await clearing
    const inserted = await inserting
    expect(inbox.snapshot()).toEqual({ nextTurn: [inserted], nextStep: [] })
    expect((await DurableInbox.restore(log)).snapshot()).toEqual(inbox.snapshot())
    await log.close()
  })

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

  it('clears both queues through one atomic durable splice and restores empty', async () => {
    const file = await tempFile('inbox-clear.jsonl')
    const first = new SessionLog(file)
    await first.init()
    const inbox = new DurableInbox(first)
    await inbox.insert({ text: 'one' })
    await inbox.steer({ text: 'two' })
    await inbox.clear()

    expect(inbox.size).toBe(0)
    const clearSplices = (await first.read()).filter(event => event.type === 'agent/inbox/spliced'
      && event.payload.target === 'all')
    expect(clearSplices).toMatchObject([{ payload: { target: 'all' } }])
    await first.flush()
    await first.close()

    const second = new SessionLog(file)
    await second.init()
    const restored = await DurableInbox.restore(second)
    expect(restored.snapshot()).toEqual({ nextTurn: [], nextStep: [] })
    await second.close()
  })

  it('keeps both queues durable and reopenable when an atomic clear append fails', async () => {
    const file = await tempFile('inbox-clear-failure.jsonl')
    const first = new SessionLog(file)
    await first.init()
    const inbox = new DurableInbox(first)
    await inbox.insert({ text: 'queued turn' })
    await inbox.steer({ text: 'staged step' })
    const persistenceFailure = new Error('clear append failed')
    vi.spyOn(first, 'append').mockRejectedValueOnce(persistenceFailure)

    await expect(inbox.clear()).rejects.toThrow('clear append failed')
    expect(inbox.snapshot()).toMatchObject({
      nextTurn: [{ text: 'queued turn' }],
      nextStep: [{ text: 'staged step' }],
    })
    await first.flush()
    await first.close()

    const second = new SessionLog(file)
    await second.init()
    const restored = await DurableInbox.restore(second)
    expect(restored.snapshot()).toMatchObject({
      nextTurn: [{ text: 'queued turn' }],
      nextStep: [{ text: 'staged step' }],
    })
    await second.close()
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
      'steer-a',
      'steer-b',
      'one',
    ])
    expect(inbox.size).toBe(1)
    expect(inbox.snapshot().nextTurn.map(message => message.text)).toEqual(['two'])
    const splices = (await log.read()).filter(event => event.type === 'agent/inbox/spliced')
    expect(splices).toHaveLength(5)
    expect((await DurableInbox.restore(log)).snapshot()).toMatchObject({
      nextTurn: [{ text: 'two' }], nextStep: [],
    })
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
