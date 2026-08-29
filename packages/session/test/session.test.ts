import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { Context } from '@tnega/core'
import {
  projectEvents,
  SessionLog,
  session,
  type ModelMessage,
  type SessionEvent,
} from '../src/index.js'

type DynamicContext = Context & {
  [key: string]: unknown
}

const dynamic = (ctx: Context): DynamicContext => ctx as unknown as DynamicContext

const dirs: string[] = []

async function tempFile(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-session-'))
  dirs.push(dir)
  return join(dir, name)
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('SessionLog append', () => {
  it('appends events with monotonic seq and writes JSONL', async () => {
    const file = await tempFile('basic.jsonl')
    const log = new SessionLog(file)
    await log.init()

    const first = await log.append('message', { role: 'user', content: 'hello' })
    const second = await log.append('message', { role: 'assistant', content: 'hi' })

    expect(first.seq).toBe(1)
    expect(second.seq).toBe(2)
    expect(first.id).not.toBe(second.id)

    const lines = (await readFile(file, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      const event = JSON.parse(line) as SessionEvent
      expect(event.id).toBeTruthy()
      expect(typeof event.ts).toBe('number')
    }
  })

  it('resumes seq from the latest event on disk', async () => {
    const file = await tempFile('resume.jsonl')
    const first = new SessionLog(file)
    await first.append('message', { role: 'user', content: 'one' })

    const second = new SessionLog(file)
    await second.init()
    const event = await second.append('meta', { kind: 'resume' })

    expect(event.seq).toBe(2)
    expect(await second.read()).toHaveLength(2)
  })

  it('serializes concurrent appends without losing events', async () => {
    const file = await tempFile('concurrent.jsonl')
    const log = new SessionLog(file)
    await log.init()

    await Promise.all([
      log.append('message', { role: 'user', content: 'a' }),
      log.append('message', { role: 'user', content: 'b' }),
      log.append('message', { role: 'user', content: 'c' }),
    ])

    const events = await log.read()
    expect(events.map(event => event.seq)).toEqual([1, 2, 3])
    expect(events.map(event => (event.payload as { content: string }).content)).toEqual(['a', 'b', 'c'])
  })

  it('links message events to their predecessor', async () => {
    const log = new SessionLog(await tempFile('parent.jsonl'))
    const user = await log.append('message', { role: 'user', content: 'hello' })
    const assistant = await log.append('message', { role: 'assistant', content: 'world' })
    const next = await log.append('message', { role: 'user', content: 'again' })

    expect((user.payload as { parentId?: string }).parentId).toBeUndefined()
    expect((assistant.payload as { parentId?: string }).parentId).toBe(user.id)
    expect((next.payload as { parentId?: string }).parentId).toBe(assistant.id)
  })

})

describe('SessionLog lineage', () => {
  it('resolves the predecessor chain for a message', async () => {
    const log = new SessionLog(await tempFile('lineage.jsonl'))
    const user = await log.append('message', { role: 'user', content: 'hello' })
    const assistant = await log.append('message', { role: 'assistant', content: 'world' })
    const next = await log.append('message', { role: 'user', content: 'again' })

    const lineage = await log.lineage(next.id)
    expect(lineage.map(event => event.id)).toEqual([user.id, assistant.id, next.id])
  })

  it('falls back to event order when parent links are missing', async () => {
    const file = await tempFile('lineage-legacy.jsonl')
    const events = [
      { id: 'a', seq: 1, ts: 1, type: 'message', payload: { role: 'user', content: 'a' } },
      { id: 'b', seq: 2, ts: 2, type: 'message', payload: { role: 'assistant', content: 'b' } },
      { id: 'c', seq: 3, ts: 3, type: 'message', payload: { role: 'user', content: 'c' } },
    ]
    await writeFile(file, `${events.map(event => JSON.stringify(event)).join('\n')}\n`, 'utf8')

    const log = new SessionLog(file)
    await log.init()
    expect((await log.lineage('c')).map(event => event.id)).toEqual(['a', 'b', 'c'])
  })

  it('rejects an unknown message id', async () => {
    const log = new SessionLog(await tempFile('lineage-unknown.jsonl'))
    await log.append('message', { role: 'user', content: 'a' })

    await expect(log.lineage('missing')).rejects.toThrow('message not found: missing')
  })
})

describe('SessionLog deriveMessages', () => {
  it('projects user, assistant, tool call and tool result history', async () => {
    const log = new SessionLog(await tempFile('derive.jsonl'))
    await log.append('message', { role: 'user', content: 'calculate 1+2' })
    await log.append('message', { role: 'assistant', content: '' })
    await log.append('tool-call', { id: 'c1', name: 'add', arguments: { a: 1, b: 2 } })
    await log.append('tool-result', {
      id: 'r1',
      toolCallId: 'c1',
      name: 'add',
      ok: true,
      output: 3,
    })
    await log.append('message', { role: 'assistant', content: '3' })

    const messages = await log.deriveMessages()
    expect(messages).toEqual([
      { role: 'user', content: 'calculate 1+2' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', name: 'add', arguments: { a: 1, b: 2 } }],
      },
      { role: 'tool', content: '3', tool_call_id: 'c1', name: 'add' },
      { role: 'assistant', content: '3' },
    ])
  })

  it('projects failed tool results as error text', async () => {
    const log = new SessionLog(await tempFile('derive-error.jsonl'))
    await log.append('message', { role: 'user', content: 'do it' })
    await log.append('tool-call', { id: 'c1', name: 'boom', arguments: {} })
    await log.append('tool-result', {
      id: 'r1',
      toolCallId: 'c1',
      name: 'boom',
      ok: false,
      durationMs: 7,
      error: { name: 'ExplosionError', message: 'exploded' },
    })

    expect(await log.deriveMessages()).toEqual([
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', name: 'boom', arguments: {} }],
      },
      {
        role: 'tool',
        content: 'error: exploded',
        tool_call_id: 'c1',
        name: 'boom',
        toolOk: false,
        toolError: { name: 'ExplosionError', message: 'exploded' },
      },
    ])
  })

  it('keeps messages immutable when callers mutate the result', async () => {
    const log = new SessionLog(await tempFile('derive-immutable.jsonl'))
    await log.append('message', { role: 'user', content: 'x' })
    const first = await log.deriveMessages()
    first[0]!.content = 'mutated'
    const second = await log.deriveMessages()
    expect(second[0]!.content).toBe('x')
  })
})

describe('SessionLog replay', () => {
  it('returns the same events as read', async () => {
    const log = new SessionLog(await tempFile('replay.jsonl'))
    await log.append('message', { role: 'user', content: 'a' })
    await log.append('message', { role: 'assistant', content: 'b' })

    expect(await log.replay()).toEqual(await log.read())
  })

  it('replays events into a state with a reducer', async () => {
    const log = new SessionLog(await tempFile('replay-reduce.jsonl'))
    await log.append('message', { role: 'user', content: 'a' })
    await log.append('message', { role: 'assistant', content: 'b' })

    const types = await log.replay((state: string[], event) => [...state, event.type], [])
    expect(types).toEqual(['message', 'message'])
  })

  it('supports async reducers in event order', async () => {
    const log = new SessionLog(await tempFile('replay-async.jsonl'))
    await log.append('message', { role: 'user', content: 'a' })
    await log.append('message', { role: 'assistant', content: 'b' })

    const contents = await log.replay(async (state: string[], event) => {
      await Promise.resolve()
      return [...state, (event.payload as { content: string }).content]
    }, [])
    expect(contents).toEqual(['a', 'b'])
  })
})

describe('SessionLog fork', () => {
  it('forks an isolated copy with the same events and seq', async () => {
    const source = new SessionLog(await tempFile('fork-source.jsonl'))
    await source.append('message', { role: 'user', content: 'hello' })
    await source.append('message', { role: 'assistant', content: 'world' })

    const targetFile = await tempFile('fork-target.jsonl')
    const child = await source.fork(targetFile)

    expect(await child.read()).toEqual(await source.read())
    const event = await child.append('message', { role: 'user', content: 'child only' })
    expect(event.seq).toBe(3)
    expect(await child.read()).toHaveLength(3)
    expect(await source.read()).toHaveLength(2)
  })

  it('lets the parent append without affecting the fork', async () => {
    const source = new SessionLog(await tempFile('fork-parent.jsonl'))
    await source.append('message', { role: 'user', content: 'parent' })
    const child = await source.fork(await tempFile('fork-child.jsonl'))

    await source.append('message', { role: 'assistant', content: 'parent later' })

    expect(await child.read()).toHaveLength(1)
    expect(await source.read()).toHaveLength(2)
  })

})

describe('SessionLog compact', () => {
  it('keeps derived history after compacting into a checkpoint', async () => {
    const log = new SessionLog(await tempFile('compact.jsonl'))
    await log.append('message', { role: 'user', content: '1+2' })
    await log.append('message', { role: 'assistant', content: '' })
    await log.append('tool-call', { id: 'c1', name: 'add', arguments: { a: 1, b: 2 } })
    await log.append('tool-result', { id: 'r1', toolCallId: 'c1', name: 'add', ok: true, output: 3 })
    const before = await log.deriveMessages()

    const count = await log.compact({ summary: 'structured summary', tokensBefore: 120 })
    expect(count).toBe(1)
    expect(await log.deriveMessages()).toEqual(before)

    const events = await log.read()
    expect(events[0]!.type).toBe('checkpoint')
    const checkpoint = events[0]!.payload as {
      messages: ModelMessage[]
      summary?: string
      tokensBefore?: number
      snapshot?: SessionEvent[]
    }
    expect(checkpoint.messages).toEqual(before)
    expect(checkpoint.summary).toBe('structured summary')
    expect(checkpoint.tokensBefore).toBe(120)
    expect(checkpoint.snapshot?.length).toBe(4)
    expect(checkpoint.snapshot?.map(event => event.type)).toEqual([
      'message',
      'message',
      'tool-call',
      'tool-result',
    ])
  })

  it('keeps the latest raw events and still reconstructs history', async () => {
    const log = new SessionLog(await tempFile('compact-keep.jsonl'))
    await log.append('message', { role: 'user', content: '1+2' })
    await log.append('message', { role: 'assistant', content: '' })
    await log.append('tool-call', { id: 'c1', name: 'add', arguments: { a: 1, b: 2 } })
    await log.append('tool-result', { id: 'r1', toolCallId: 'c1', name: 'add', ok: true, output: 3 })
    await log.append('message', { role: 'assistant', content: '3' })
    const before = await log.deriveMessages()

    const count = await log.compact({ keep: 2 })
    expect(count).toBe(3)
    expect(await log.deriveMessages()).toEqual(before)

    const events = await log.read()
    expect(events[0]!.type).toBe('checkpoint')
    expect(events.slice(1).map(event => event.type)).toEqual(['tool-result', 'message'])
    const checkpoint = events[0]!.payload as { snapshot?: SessionEvent[] }
    expect(checkpoint.snapshot?.length).toBe(3)
    expect(checkpoint.snapshot?.map(event => event.type)).toEqual([
      'message',
      'message',
      'tool-call',
    ])
  })

  it('can append after compact with a fresh seq', async () => {
    const log = new SessionLog(await tempFile('compact-append.jsonl'))
    await log.append('message', { role: 'user', content: 'a' })
    await log.append('message', { role: 'assistant', content: 'b' })
    await log.compact()

    const event = await log.append('message', { role: 'user', content: 'c' })
    expect(event.seq).toBe(3)
    expect((await log.deriveMessages()).map(message => message.content)).toEqual(['a', 'b', 'c'])
  })
})

describe('session plugin', () => {
  it('provides and removes ctx.session when unloaded', async () => {
    const root = new Context()
    const fiber = root.plugin(session, { file: await tempFile('plugin.jsonl') })
    await fiber

    const log = dynamic(root).session as SessionLog
    await log.append('message', { role: 'user', content: 'via plugin' })
    expect(await log.deriveMessages()).toEqual([{ role: 'user', content: 'via plugin' }])

    await fiber.dispose()
    expect(dynamic(root).session).toBeUndefined()
  })

  it('keeps the session log file after the plugin unloads', async () => {
    const file = await tempFile('plugin-persist.jsonl')
    const root = new Context()
    const fiber = root.plugin(session, { file })
    await fiber
    await (dynamic(root).session as SessionLog).append('message', { role: 'user', content: 'persist' })
    await fiber.dispose()

    const text = await readFile(file, 'utf8')
    expect(text.trim()).not.toHaveLength(0)
    expect(text).toContain('persist')
  })
})

describe('projectEvents', () => {
  it('ignores meta events and handles checkpoint seeds', () => {
    const events: SessionEvent[] = [
      {
        id: 'm1',
        seq: 1,
        ts: 1,
        type: 'meta',
        payload: { kind: 'note' },
      },
      {
        id: 'c1',
        seq: 2,
        ts: 2,
        type: 'checkpoint',
        payload: { messages: [{ role: 'user', content: 'seeded' }] },
      },
      {
        id: 'm2',
        seq: 3,
        ts: 3,
        type: 'message',
        payload: { role: 'assistant', content: 'after' },
      },
    ]

    expect(projectEvents(events)).toEqual([
      { role: 'user', content: 'seeded' },
      { role: 'assistant', content: 'after' },
    ])
  })

  it('accepts an empty event stream', () => {
    expect(projectEvents([])).toEqual([])
  })
})
