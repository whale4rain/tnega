import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'

const { appendFileMock } = vi.hoisted(() => ({ appendFileMock: { fail: false } }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    appendFile: async (
      path: Parameters<typeof actual.appendFile>[0],
      data: Parameters<typeof actual.appendFile>[1],
      options?: Parameters<typeof actual.appendFile>[2],
    ) => {
      if (appendFileMock.fail) throw new Error('disk full')
      return actual.appendFile(path, data, options)
    },
  }
})

import { Context } from '@tnega/core'
import {
  estimateContextUsage,
  estimateEventTokens,
  estimateMessageTokens,
  deriveEventMessage,
  foldRequestContext,
  foldRequestHeader,
  foldSurface,
  isAppendSurfaceEvent,
  projectEvents,
  repairUnclosed,
  resolveCompactKeep,
  safeCompactSplit,
  SessionLog,
  SessionFormatError,
  session,
  suffixStartIndexForTokens,
  type ModelMessage,
  type PlanPayload,
  type SessionEvent,
} from '../src/index.js'

type DynamicContext = Context & {
  [key: string]: unknown
}

const dynamic = (ctx: Context): DynamicContext => ctx as unknown as DynamicContext

type MessageEvent = Extract<
  SessionEvent,
  { type: 'user/message' | 'assistant/message' | 'system/message' }
>

const dirs: string[] = []

async function tempFile(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-session-'))
  dirs.push(dir)
  return join(dir, name)
}

function withFormatMeta(events: SessionEvent[]): SessionEvent[] {
  return [
    {
      id: 'meta-format',
      seq: 1,
      ts: 1,
      type: 'meta',
      payload: { formatVersion: 5 },
    },
    ...events.map((event, index) => ({ ...event, seq: event.seq + 1, ts: index + 2 })),
  ]
}

async function writeV5(file: string, events: SessionEvent[]): Promise<void> {
  const all = withFormatMeta(events)
  await writeFile(file, `${all.map(event => JSON.stringify(event)).join('\n')}\n`, 'utf8')
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('SessionLog append', () => {
  it('appends events with monotonic seq and writes JSONL', async () => {
    const file = await tempFile('basic.jsonl')
    const log = new SessionLog(file)
    await log.init()

    const first = await log.append('user/message', { content: 'hello' })
    const second = await log.append('assistant/message', { content: 'hi' })

    expect(first.seq).toBe(2)
    expect(second.seq).toBe(3)
    expect(first.id).not.toBe(second.id)

    await log.flush()
    const lines = (await readFile(file, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(3)
    expect((JSON.parse(lines[0]!) as SessionEvent).type).toBe('meta')
    for (const line of lines) {
      const event = JSON.parse(line) as SessionEvent
      expect(event.id).toBeTruthy()
      expect(typeof event.ts).toBe('number')
    }
  })

  it('resumes seq from the latest event on disk', async () => {
    const file = await tempFile('resume.jsonl')
    const first = new SessionLog(file)
    await first.append('user/message', { content: 'one' })
    await first.flush()

    const second = new SessionLog(file)
    await second.init()
    const event = await second.append('meta', { kind: 'resume' })

    expect(event.seq).toBe(3)
    expect(await second.read()).toHaveLength(3)
  })

  it('serializes concurrent appends without losing events', async () => {
    const file = await tempFile('concurrent.jsonl')
    const log = new SessionLog(file)
    await log.init()

    await Promise.all([
      log.append('user/message', { content: 'a' }),
      log.append('user/message', { content: 'b' }),
      log.append('user/message', { content: 'c' }),
    ])

    const events = await log.read()
    expect(events.map(event => event.seq)).toEqual([1, 2, 3, 4])
    expect(events
      .filter(event => event.type === 'user/message')
      .map(event => (event.payload as { content: string }).content))
      .toEqual(['a', 'b', 'c'])
  })

  it('links message events to their predecessor', async () => {
    const log = new SessionLog(await tempFile('parent.jsonl'))
    const user = await log.append('user/message', { content: 'hello' })
    const assistant = await log.append('assistant/message', { content: 'world' })
    const next = await log.append('user/message', { content: 'again' })

    expect((user.payload as { parentId?: string }).parentId).toBeUndefined()
    expect((assistant.payload as { parentId?: string }).parentId).toBe(user.id)
    expect((next.payload as { parentId?: string }).parentId).toBe(assistant.id)
  })

  it('appends plan events with item status and persists them', async () => {
    const file = await tempFile('plan.jsonl')
    const log = new SessionLog(file)
    await log.init()

    const plan = await log.append('plan', {
      summary: 'build a todo list',
      status: 'pending',
      items: [
        { id: 'p1', title: 'write code', status: 'pending' },
        { id: 'p2', title: 'run tests', status: 'pending', detail: 'pnpm test' },
      ],
    })

    expect(plan.type).toBe('plan')
    const payload = plan.payload as PlanPayload
    expect(payload.items).toHaveLength(2)
    expect(payload.items[0]).toMatchObject({ id: 'p1', status: 'pending' })

    await log.flush()
    const reloaded = new SessionLog(file)
    await reloaded.init()
    const events = await reloaded.read()
    expect(events).toHaveLength(2)
    expect(events[0]?.type).toBe('meta')
    expect(events[1]?.type).toBe('plan')
  })
})

describe('plan event projection and estimation', () => {
  it('ignores plan events when projecting model messages', async () => {
    const file = await tempFile('plan-project.jsonl')
    const log = new SessionLog(file)
    await log.init()
    await log.append('plan', {
      items: [{ id: 'p1', title: 'step one', status: 'pending' }],
    })
    await log.append('user/message', { content: 'hello' })

    const messages = await log.deriveMessages()
    expect(messages).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('counts zero tokens for plan events', () => {
    const event: SessionEvent = {
      id: 'plan-1',
      seq: 1,
      ts: 1,
      type: 'plan',
      payload: {
        summary: 'a very long plan summary that should not cost tokens',
        items: [
          { id: 'p1', title: 'step', status: 'pending', detail: 'detail' },
        ],
      },
    }
    expect(estimateEventTokens(event)).toBe(0)
  })
})

describe('SessionLog lineage', () => {
  it('resolves the predecessor chain for a message', async () => {
    const log = new SessionLog(await tempFile('lineage.jsonl'))
    const user = await log.append('user/message', { content: 'hello' })
    const assistant = await log.append('assistant/message', { content: 'world' })
    const next = await log.append('user/message', { content: 'again' })

    const lineage = await log.lineage(next.id)
    expect(lineage.map(event => event.id)).toEqual([user.id, assistant.id, next.id])
  })

  it('falls back to event order when parent links are missing', async () => {
    const file = await tempFile('lineage-legacy.jsonl')
    const events: SessionEvent[] = [
      { id: 'a', seq: 1, ts: 1, type: 'user/message', payload: { content: 'a' } },
      { id: 'b', seq: 2, ts: 2, type: 'assistant/message', payload: { content: 'b' } },
      { id: 'c', seq: 3, ts: 3, type: 'user/message', payload: { content: 'c' } },
    ]
    await writeV5(file, events)

    const log = new SessionLog(file)
    await log.init()
    expect((await log.lineage('c')).map(event => event.id)).toEqual(['a', 'b', 'c'])
  })

  it('rejects an unknown message id', async () => {
    const log = new SessionLog(await tempFile('lineage-unknown.jsonl'))
    await log.append('user/message', { content: 'a' })

    await expect(log.lineage('missing')).rejects.toThrow('message not found: missing')
  })
})

describe('SessionLog forkAt', () => {
  it('copies the message lineage up to the selected message', async () => {
    const log = new SessionLog(await tempFile('fork-at.jsonl'))
    const a = await log.append('user/message', { content: 'a' })
    await log.append('assistant/message', { content: 'b' })
    const c = await log.append('user/message', { content: 'c' })
    await log.append('assistant/message', { content: 'd' })

    const events = await log.forkAt(c.id)
    expect(events.map(event => event.type)).toEqual([
      'user/message',
      'assistant/message',
      'user/message',
    ])
    expect(events.map(event => (event.payload as { content: string }).content)).toEqual([
      'a',
      'b',
      'c',
    ])
    const all = await log.read()
    const assistant = all.find(event => event.type === 'assistant/message')!
    expect(events.map(event => event.id)).toEqual([a.id, assistant.id, c.id])
  })

  it('follows parent links instead of raw event order', async () => {
    const file = await tempFile('fork-at-lineage.jsonl')
    const events: SessionEvent[] = [
      {
        id: 'root',
        seq: 1,
        ts: 1,
        type: 'user/message',
        payload: { content: 'root', parentId: 'missing' },
      },
      {
        id: 'branch',
        seq: 2,
        ts: 2,
        type: 'assistant/message',
        payload: { content: 'branch', parentId: 'root' },
      },
      {
        id: 'orphan',
        seq: 3,
        ts: 3,
        type: 'user/message',
        payload: { content: 'orphan', parentId: 'branch' },
      },
      {
        id: 'orphan-tool',
        seq: 4,
        ts: 4,
        type: 'tool/call',
        payload: { id: 'tool-1', name: 'orphan-tool', arguments: {} },
      },
      {
        id: 'first',
        seq: 5,
        ts: 5,
        type: 'user/message',
        payload: { content: 'first', parentId: 'branch' },
      },
      {
        id: 'second',
        seq: 6,
        ts: 6,
        type: 'assistant/message',
        payload: { content: 'second', parentId: 'first' },
      },
    ]
    await writeV5(file, events)

    const log = new SessionLog(file)
    await log.init()
    const selected = await log.forkAt('second')
    expect(selected.map(event => event.id)).toEqual(['root', 'branch', 'first', 'second'])
    expect(selected.some(event => event.id === 'orphan-tool')).toBe(false)
  })

  it('keeps a checkpoint prefix when history starts before the lineage', async () => {
    const log = new SessionLog(await tempFile('fork-at-checkpoint.jsonl'))
    await log.append('user/message', { content: 'old user' })
    await log.append('assistant/message', { content: 'old reply' })
    await log.compact()
    const next = await log.append('user/message', { content: 'recent' })

    const selected = await log.forkAt(next.id)
    expect(selected.map(event => event.type)).toEqual([
      'user/message',
      'assistant/message',
      'compaction/start',
      'checkpoint',
      'compaction/end',
      'user/message',
    ])
    const checkpoint = selected.find(event => event.type === 'checkpoint')!
    const payload = checkpoint.payload as { messages?: ModelMessage[]; surfaceOp?: string }
    expect(payload.messages).toHaveLength(2)
    expect(payload.surfaceOp).toBe('replace')
  })
})

describe('SessionLog deriveMessages', () => {
  it('projects user, assistant, tool call and tool result history', async () => {
    const log = new SessionLog(await tempFile('derive.jsonl'))
    await log.append('user/message', { content: 'calculate 1+2' })
    await log.append('assistant/message', { content: '' })
    await log.append('tool/call', { id: 'c1', name: 'add', arguments: { a: 1, b: 2 } })
    await log.append('tool/result', {
      id: 'r1',
      toolCallId: 'c1',
      name: 'add',
      ok: true,
      output: 3,
    })
    await log.append('assistant/message', { content: '3' })

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
    await log.append('user/message', { content: 'do it' })
    await log.append('tool/call', { id: 'c1', name: 'boom', arguments: {} })
    await log.append('tool/result', {
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
    await log.append('user/message', { content: 'x' })
    const first = await log.deriveMessages()
    first[0]!.content = 'mutated'
    const second = await log.deriveMessages()
    expect(second[0]!.content).toBe('x')
  })
})

describe('SessionLog replay', () => {
  it('returns the same events as read', async () => {
    const log = new SessionLog(await tempFile('replay.jsonl'))
    await log.append('user/message', { content: 'a' })
    await log.append('assistant/message', { content: 'b' })

    expect(await log.replay()).toEqual(await log.read())
  })

  it('replays events into a state with a reducer', async () => {
    const log = new SessionLog(await tempFile('replay-reduce.jsonl'))
    await log.append('user/message', { content: 'a' })
    await log.append('assistant/message', { content: 'b' })

    const types = await log.replay((state: string[], event) => [...state, event.type], [])
    expect(types).toEqual(['meta', 'user/message', 'assistant/message'])
  })

  it('supports async reducers in event order', async () => {
    const log = new SessionLog(await tempFile('replay-async.jsonl'))
    await log.append('user/message', { content: 'a' })
    await log.append('assistant/message', { content: 'b' })

    const contents = await log.replay(async (state: string[], event) => {
      await Promise.resolve()
      return [...state, (event.payload as { content: string }).content]
    }, [])
    expect(contents).toEqual([undefined, 'a', 'b'])
  })
})

describe('SessionLog lifecycle and repair', () => {
  it('leaves a closed event stream untouched', () => {
    expect(repairUnclosed([])).toEqual([])
  })

  it('appends lifecycle events without affecting the message surface', async () => {
    const log = new SessionLog(await tempFile('lifecycle.jsonl'))
    await log.append('turn/start', { turn: 1, input: 'hello', reason: 'user' })
    await log.append('step/start', { turn: 1, step: 0 })
    await log.append('user/message', { content: 'hello' })
    await log.append('assistant/message', { content: 'hi' })
    await log.append('step/end', { turn: 1, step: 0 })
    await log.append('turn/end', { turn: 1, finishReason: 'stop', steps: 1 })

    expect(await log.deriveMessages()).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ])
    const events = await log.read()
    expect(events.map(event => event.type)).toEqual([
      'meta',
      'turn/start',
      'step/start',
      'user/message',
      'assistant/message',
      'step/end',
      'turn/end',
    ])
    for (const event of events.filter(event => (
      event.type === 'turn/start'
      || event.type === 'turn/end'
      || event.type === 'step/start'
      || event.type === 'step/end'
    ))) {
      expect(estimateEventTokens(event)).toBe(0)
    }
  })

  it('repairs unclosed tool calls, steps and turns on load', async () => {
    const file = await tempFile('repair.jsonl')
    await writeV5(file, [
      {
        id: 'turn-1',
        seq: 1,
        ts: 1,
        type: 'turn/start',
        payload: { turn: 1, input: 'go' },
      },
      {
        id: 'step-1',
        seq: 2,
        ts: 2,
        type: 'step/start',
        payload: { turn: 1, step: 0 },
      },
      {
        id: 'call-1',
        seq: 3,
        ts: 3,
        type: 'tool/call',
        payload: { id: 'c1', name: 'read', arguments: {} },
      },
    ])

    const log = new SessionLog(file)
    await log.init()
    const events = await log.read()
    expect(events.map(event => event.type)).toEqual([
      'meta',
      'turn/start',
      'step/start',
      'tool/call',
      'tool/result',
      'step/end',
      'turn/end',
    ])
    expect(events.map(event => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7])
    const result = events[4]!
    expect(result.type).toBe('tool/result')
    expect(result.payload).toMatchObject({
      id: 'c1',
      toolCallId: 'c1',
      name: 'read',
      ok: false,
    })
    expect(events[5]).toMatchObject({
      type: 'step/end',
      payload: { turn: 1, step: 0, interrupted: true, finishReason: 'interrupted' },
    })
    expect(events[6]).toMatchObject({
      type: 'turn/end',
      payload: { turn: 1, interrupted: true, finishReason: 'interrupted' },
    })
  })

  it('does not synthesize closures while a live writer owns the log', async () => {
    const file = await tempFile('live-reader.jsonl')
    const writer = new SessionLog(file)
    await writer.init()
    await writer.append('turn/start', { turn: 1, input: 'go', reason: 'user' })
    await writer.append('step/start', { turn: 1, step: 0 })
    await writer.append('user/message', { content: 'go' })
    await writer.flush()

    const reader = new SessionLog(file)
    await reader.init()
    const events = await reader.read()
    expect(events.map(event => event.type)).toEqual([
      'meta',
      'turn/start',
      'step/start',
      'user/message',
    ])
    expect(events.map(event => event.seq)).toEqual([1, 2, 3, 4])

    const text = await readFile(file, 'utf8')
    expect(text.trimEnd().split('\n')).toHaveLength(4)

    await writer.append('step/end', { turn: 1, step: 0 })
    await writer.append('turn/end', { turn: 1, finishReason: 'stop', steps: 1 })
    await writer.close()
    const reopened = new SessionLog(file)
    await reopened.init()
    const closed = await reopened.read()
    expect(closed.map(event => event.type)).toEqual([
      'meta',
      'turn/start',
      'step/start',
      'user/message',
      'step/end',
      'turn/end',
    ])
    await reopened.close()
  })

  it('lets a second reader see unflushed events from a live owner', async () => {
    const file = await tempFile('live-pending.jsonl')
    const writer = new SessionLog(file)
    await writer.init()
    await writer.append('user/message', { content: 'pending' })

    const reader = new SessionLog(file)
    await reader.init()
    expect(await reader.read()).toEqual(await writer.read())

    await writer.flush()
    expect((await readFile(file, 'utf8')).trimEnd().split('\n')).toHaveLength(2)
    await writer.close()
  })

  it('propagates flush failures and retries later appends', async () => {
    const file = await tempFile('flush-failure.jsonl')
    const log = new SessionLog(file)
    appendFileMock.fail = true
    await log.append('user/message', { content: 'a' })

    await expect(log.flush()).rejects.toThrow('disk full')

    appendFileMock.fail = false
    await log.append('user/message', { content: 'b' })
    const seq = await log.flush()
    expect(seq).toBe(3)
    const text = await readFile(file, 'utf8')
    expect(text).toContain('"b"')
    await log.close()
  })

  it('drops a torn tail and rewrites the file', async () => {
    const file = await tempFile('torn.jsonl')
    await writeV5(file, [
      {
        id: 'm1',
        seq: 1,
        ts: 1,
        type: 'user/message',
        payload: { content: 'hello' },
      },
    ])
    await writeFile(file, `${await readFile(file, 'utf8')}{"id":"partial"\n`, 'utf8')

    const log = new SessionLog(file)
    await log.init()
    const events = await log.read()
    expect(events.map(event => event.type)).toEqual(['meta', 'user/message'])

    const text = await readFile(file, 'utf8')
    expect(text).not.toContain('partial')
    expect(text.trimEnd().split('\n')).toHaveLength(2)
  })

  it('rejects files without the current format version', async () => {
    const file = await tempFile('format-version.jsonl')
    await writeFile(file, `${JSON.stringify({
      id: 'meta-old',
      seq: 1,
      ts: 1,
      type: 'meta',
      payload: { formatVersion: 1 },
    })}\n`, 'utf8')

    const log = new SessionLog(file)
    await expect(log.init()).rejects.toBeInstanceOf(SessionFormatError)
  })
})

describe('compact boundary safety', () => {
  it('never splits a tool call from its result', () => {
    const events: SessionEvent[] = [
      {
        id: 'm1',
        seq: 1,
        ts: 1,
        type: 'user/message',
        payload: { content: 'a' },
      },
      {
        id: 'm2',
        seq: 2,
        ts: 2,
        type: 'assistant/message',
        payload: { content: '' },
      },
      {
        id: 'c1',
        seq: 3,
        ts: 3,
        type: 'tool/call',
        payload: { id: 'c1', name: 'read', arguments: {} },
      },
      {
        id: 'r1',
        seq: 4,
        ts: 4,
        type: 'tool/result',
        payload: { id: 'r1', toolCallId: 'c1', name: 'read', ok: true },
      },
      {
        id: 'm3',
        seq: 5,
        ts: 5,
        type: 'user/message',
        payload: { content: 'b' },
      },
    ]

    expect(safeCompactSplit(events, 3)).toBe(2)
    expect(safeCompactSplit(events, 2)).toBe(2)
  })
})

describe('SessionLog compact', () => {
  it('keeps derived history after compacting into a checkpoint', async () => {
    const log = new SessionLog(await tempFile('compact.jsonl'))
    await log.append('user/message', { content: '1+2' })
    await log.append('assistant/message', { content: '' })
    await log.append('tool/call', { id: 'c1', name: 'add', arguments: { a: 1, b: 2 } })
    await log.append('tool/result', { id: 'r1', toolCallId: 'c1', name: 'add', ok: true, output: 3 })
    const before = await log.deriveMessages()

    const count = await log.compact({ summary: 'structured summary', tokensBefore: 120 })
    expect(count).toBe(8)
    expect(await log.deriveMessages()).toEqual(before)

    const events = await log.read()
    expect(events.at(-2)!.type).toBe('checkpoint')
    const checkpoint = events.at(-2)!.payload as {
      messages: ModelMessage[]
      summary?: string
      tokensBefore?: number
      surfaceOp?: string
    }
    expect(checkpoint.messages).toEqual(before)
    expect(checkpoint.summary).toBe('structured summary')
    expect(checkpoint.tokensBefore).toBe(120)
    expect(checkpoint.surfaceOp).toBe('replace')
    expect(events.at(-1)!.type).toBe('compaction/end')
    expect(events.slice(-3).map(event => event.type)).toEqual([
      'compaction/start',
      'checkpoint',
      'compaction/end',
    ])
    expect(events.slice(0, -1).map(event => event.type)).toEqual([
      'meta',
      'user/message',
      'assistant/message',
      'tool/call',
      'tool/result',
      'compaction/start',
      'checkpoint',
    ])
  })

  it('keeps the latest raw events and still reconstructs history', async () => {
    const log = new SessionLog(await tempFile('compact-keep.jsonl'))
    await log.append('user/message', { content: '1+2' })
    await log.append('assistant/message', { content: '' })
    await log.append('tool/call', { id: 'c1', name: 'add', arguments: { a: 1, b: 2 } })
    await log.append('tool/result', { id: 'r1', toolCallId: 'c1', name: 'add', ok: true, output: 3 })
    await log.append('assistant/message', { content: '3' })
    const before = await log.deriveMessages()

    const count = await log.compact({ keep: 2 })
    expect(count).toBe(9)
    expect(await log.deriveMessages()).toEqual(before)

    const events = await log.read()
    expect(events.at(-2)!.type).toBe('checkpoint')
    expect(events.slice(0, -1).map(event => event.type)).toEqual([
      'meta',
      'user/message',
      'assistant/message',
      'tool/call',
      'tool/result',
      'assistant/message',
      'compaction/start',
      'checkpoint',
    ])
    const checkpoint = events.at(-2)!.payload as { surfaceOp?: string }
    expect(checkpoint.surfaceOp).toBe('replace')
  })

  it('stores explicit compacted messages instead of the prefix projection', async () => {
    const log = new SessionLog(await tempFile('compact-messages.jsonl'))
    await log.append('user/message', { content: 'old context' })
    await log.append('assistant/message', { content: 'done' })

    const compacted: ModelMessage[] = [
      { role: 'system', content: 'compacted summary' },
    ]
    const count = await log.compact({
      keepTokens: 1,
      summary: 'compacted summary',
      tokensBefore: 100,
      messages: compacted,
    })
    expect(count).toBe(6)

    const events = await log.read()
    expect(events.at(-2)!.type).toBe('checkpoint')
    const checkpoint = events.at(-2)!.payload as {
      messages: ModelMessage[]
      summary?: string
      tokensBefore?: number
      surfaceOp?: string
    }
    expect(checkpoint.messages).toEqual([
      ...compacted,
      { role: 'assistant', content: 'done' },
    ])
    expect(checkpoint.summary).toBe('compacted summary')
    expect(checkpoint.tokensBefore).toBe(100)
    expect(checkpoint.surfaceOp).toBe('replace')
    expect(await log.deriveMessages()).toEqual([
      ...compacted,
      { role: 'assistant', content: 'done' },
    ])
  })

  it('can append after compact with a fresh seq', async () => {
    const log = new SessionLog(await tempFile('compact-append.jsonl'))
    await log.append('user/message', { content: 'a' })
    await log.append('assistant/message', { content: 'b' })
    await log.compact()

    const event = await log.append('user/message', { content: 'c' })
    expect(event.seq).toBe(7)
    expect((await log.deriveMessages()).map(message => message.content)).toEqual(['a', 'b', 'c'])
  })
})

describe('session plugin', () => {
  it('provides and removes ctx.session when unloaded', async () => {
    const root = new Context()
    const fiber = root.plugin(session, { file: await tempFile('plugin.jsonl') })
    await fiber

    const log = dynamic(root).session as SessionLog
    await log.append('user/message', { content: 'via plugin' })
    expect(await log.deriveMessages()).toEqual([{ role: 'user', content: 'via plugin' }])

    await fiber.dispose()
    expect(dynamic(root).session).toBeUndefined()
  })

  it('keeps the session log file after the plugin unloads', async () => {
    const file = await tempFile('plugin-persist.jsonl')
    const root = new Context()
    const fiber = root.plugin(session, { file })
    await fiber
    await (dynamic(root).session as SessionLog).append('user/message', { content: 'persist' })
    await fiber.dispose()

    const text = await readFile(file, 'utf8')
    expect(text.trim()).not.toHaveLength(0)
    expect(text).toContain('persist')
  })

  it('broadcasts appended events and flush checkpoints', async () => {
    const root = new Context()
    const fiber = root.plugin(session, { file: await tempFile('plugin-broadcast.jsonl') })
    await fiber

    const live: string[] = []
    let flushPayload: { file: string; seq: number } | undefined
    root.on('session/event', (event: SessionEvent) => live.push(event.type))
    root.on('session/flush', (payload: { file: string; seq: number }) => {
      flushPayload = payload
    })

    const log = dynamic(root).session as SessionLog
    await log.append('user/message', { content: 'broadcast' })
    expect(live).toEqual(['user/message'])

    const seq = await log.flush()
    expect(seq).toBe(2)
    expect(flushPayload?.seq).toBe(2)
    await fiber.dispose()
  })

  it('invokes a custom broadcast callback', async () => {
    const broadcasts: string[] = []
    const file = await tempFile('broadcast-custom.jsonl')
    const log = new SessionLog(file, undefined, (type, payload) => {
      broadcasts.push(`${type}:${(payload as { type?: string }).type ?? 'flush'}`)
    })
    await log.append('user/message', { content: 'a' })
    await log.flush()

    expect(broadcasts).toEqual(['event:user/message', 'flush:flush'])
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
        type: 'assistant/message',
        payload: { content: 'after' },
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

describe('SessionProjector', () => {
  it('derives messages through a custom projector', async () => {
    const file = await tempFile('projector.jsonl')
    const log = new SessionLog(file, (events) => (
      events
        .filter((event): event is MessageEvent => (
          event.type === 'user/message'
          || event.type === 'assistant/message'
          || event.type === 'system/message'
        ))
        .map((event) => ({
          role: 'system' as const,
          content: `[${event.type.split('/')[0]}] ${event.payload.content}`,
        }))
    ))
    await log.append('user/message', { content: 'hello' })
    await log.append('assistant/message', { content: 'hi' })

    expect(await log.deriveMessages()).toEqual([
      { role: 'system', content: '[user] hello' },
      { role: 'system', content: '[assistant] hi' },
    ])
    const usage = await log.estimateContext(100)
    expect(usage.tokens).toBe(Math.ceil('[user] hello'.length / 4) + Math.ceil('[assistant] hi'.length / 4))
    expect(usage.limit).toBe(100)
  })

  it('passes a projector through the session plugin', async () => {
    const root = new Context()
    const fiber = root.plugin(session, {
      file: await tempFile('projector-plugin.jsonl'),
      projector: (events: readonly SessionEvent[]) => (
        events
          .filter((event: SessionEvent): event is MessageEvent => (
            event.type === 'user/message'
            || event.type === 'assistant/message'
            || event.type === 'system/message'
          ))
          .map((event: MessageEvent) => ({
            role: 'assistant' as const,
            content: event.payload.content.toUpperCase(),
          }))
      ),
    })
    await fiber

    const log = dynamic(root).session as SessionLog
    await log.append('user/message', { content: 'ping' })
    expect(await log.deriveMessages()).toEqual([{ role: 'assistant', content: 'PING' }])
    await fiber.dispose()
  })

  it('uses the projector when compacting into a checkpoint', async () => {
    const file = await tempFile('projector-compact.jsonl')
    const log = new SessionLog(file, (events: readonly SessionEvent[]) => {
      const messages: ModelMessage[] = []
      for (const event of events) {
        if (event.type === 'checkpoint') {
          messages.splice(0, messages.length, ...event.payload.messages)
        } else if (
          event.type === 'user/message'
          || event.type === 'assistant/message'
          || event.type === 'system/message'
        ) {
          messages.push({ role: 'system', content: event.payload.content })
        }
      }
      return messages
    })
    await log.append('user/message', { content: 'a' })
    await log.append('assistant/message', { content: 'b' })

    await log.compact()
    expect(await log.deriveMessages()).toEqual([
      { role: 'system', content: 'a' },
      { role: 'system', content: 'b' },
    ])
  })
})

describe('v5 reconstructable request state', () => {
  it('records a request header snapshot and folds the latest one', async () => {
    const log = new SessionLog(await tempFile('request-header.jsonl'))
    await log.append('request/header', {
      reason: 'initial',
      config: { provider: 'deepseek', model: 'v4-flash', maxTokens: 4096 },
      system: 'You are Tnega.',
      tools: [{ name: 'read', description: 'read a file' }],
    })
    await log.append('request/header', {
      reason: 'change',
      config: { provider: 'deepseek', model: 'v4-flash', maxTokens: 8192 },
    })

    const events = await log.read()
    expect(events.filter(event => event.type === 'request/header')).toHaveLength(2)
    expect(foldRequestHeader(events)).toMatchObject({
      reason: 'change',
      config: { provider: 'deepseek', model: 'v4-flash', maxTokens: 8192 },
    })
    expect(log.requestHeader()).toMatchObject({ reason: 'change' })
  })

  it('records route capacity separately and folds the latest record', async () => {
    const log = new SessionLog(await tempFile('request-context.jsonl'))
    await log.append('request/context', { provider: 'deepseek', model: 'v4-flash', contextWindow: 128000 })
    await log.append('request/context', { provider: 'other', model: 'm' })

    const events = await log.read()
    expect(foldRequestContext(events)).toEqual({ provider: 'other', model: 'm' })
    expect(log.requestContext()).toEqual({ provider: 'other', model: 'm' })
  })

  it('scopes turn and step events with numeric coordinates', async () => {
    const log = new SessionLog(await tempFile('coordinates.jsonl'))
    await log.append('turn/start', { turn: 1, input: 'go', reason: 'user' })
    await log.append('step/start', { turn: 1, step: 0 })
    await log.append('step/end', { turn: 1, step: 0, finishReason: 'stop' })
    await log.append('turn/end', { turn: 1, finishReason: 'stop', steps: 1 })

    const events = await log.read()
    expect(events.find(event => event.type === 'step/start')?.payload).toEqual({ turn: 1, step: 0 })
    expect(events.find(event => event.type === 'step/end')?.payload).toEqual({
      turn: 1,
      step: 0,
      finishReason: 'stop',
    })
    expect(events.find(event => event.type === 'turn/end')?.payload).toMatchObject({ turn: 1 })
  })
})

describe('v5 surface folding', () => {
  it('marks append surface events and folds a replace operation', () => {
    const appended: SessionEvent = {
      id: 'a',
      seq: 1,
      ts: 1,
      type: 'user/message',
      payload: { content: 'old' },
      surfaceOp: 'append',
      sourceEventSeqs: [],
    }
    const replacement: SessionEvent = {
      id: 'r',
      seq: 2,
      ts: 2,
      type: 'assistant/message',
      payload: { content: 'new' },
      surfaceOp: { op: 'replace', start: 1, end: 1 },
      sourceEventSeqs: [1],
    }
    expect(isAppendSurfaceEvent(appended)).toBe(true)
    expect(isAppendSurfaceEvent(replacement)).toBe(false)
    const folded = foldSurface([appended, replacement])
    expect(folded.nodes).toEqual([2])
    expect(folded.replacements).toEqual([
      { seq: 2, start: 1, end: 1, shadowedSeqs: [1] },
    ])
    expect(deriveEventMessage(appended)).toEqual({ role: 'user', content: 'old' })
    expect(deriveEventMessage(replacement)).toEqual({ role: 'assistant', content: 'new' })
  })
})

describe('SessionLog surfaceEvents', () => {
  it('returns only events that survive the surface projection', async () => {
    const log = new SessionLog(await tempFile('surface-events.jsonl'))
    await log.append('user/message', { content: 'one' })
    await log.append('assistant/message', { content: 'answer' })
    await log.append('assistant/chunk', { id: 'c1', content: 'partial', index: 0 })

    const surface = await log.surfaceEvents()
    expect(surface.map(event => event.type)).toEqual([
      'user/message',
      'assistant/message',
    ])
    expect(surface.map(event => event.payload)).toMatchObject([
      { content: 'one' },
      { content: 'answer' },
    ])
  })
})

describe('context budget', () => {
  it('estimates tokens from messages and tool call arguments', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'aaaaaaaa' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'c1',
            name: 'read',
            arguments: { key: 'aaaaaaaa' },
          },
        ],
      },
    ]
    const expected = 2 + Math.ceil('{"key":"aaaaaaaa"}'.length / 4)
    expect(estimateMessageTokens(messages)).toBe(expected)
    expect(estimateContextUsage(messages, 10)).toEqual({
      tokens: expected,
      limit: 10,
      ratio: expected / 10,
    })
  })

  it('estimates event tokens for every session event type', () => {
    const message: SessionEvent = {
      id: 'm1',
      seq: 1,
      ts: 1,
      type: 'user/message',
      payload: { content: 'aaaaaaaa' },
    }
    const toolCall: SessionEvent = {
      id: 't1',
      seq: 2,
      ts: 2,
      type: 'tool/call',
      payload: { id: 't1', name: 'read', arguments: { key: 'aaaaaaaa' } },
    }
    const toolResult: SessionEvent = {
      id: 'r1',
      seq: 3,
      ts: 3,
      type: 'tool/result',
      payload: {
        id: 'r1',
        toolCallId: 't1',
        name: 'read',
        ok: true,
        output: { value: 'aaaaaaaa' },
      },
    }
    const checkpoint: SessionEvent = {
      id: 'c1',
      seq: 4,
      ts: 4,
      type: 'checkpoint',
      payload: { messages: [{ role: 'user', content: 'aaaaaaaa' }] },
    }
    const meta: SessionEvent = {
      id: 'meta1',
      seq: 5,
      ts: 5,
      type: 'meta',
      payload: {},
    }

    expect(estimateEventTokens(message)).toBe(2)
    expect(estimateEventTokens(toolCall)).toBe(Math.ceil('{"key":"aaaaaaaa"}'.length / 4))
    expect(estimateEventTokens(toolResult)).toBe(
      Math.ceil('{"value":"aaaaaaaa"}'.length / 4),
    )
    expect(estimateEventTokens(checkpoint)).toBe(2)
    expect(estimateEventTokens(meta)).toBe(0)
  })

  it('finds a token budget boundary and resolves compact keep', () => {
    const events: SessionEvent[] = [
      {
        id: 'm1',
        seq: 1,
        ts: 1,
        type: 'user/message',
        payload: { content: 'aaaa' },
      },
      {
        id: 'm2',
        seq: 2,
        ts: 2,
        type: 'user/message',
        payload: { content: 'bbbbbbbb' },
      },
      {
        id: 'm3',
        seq: 3,
        ts: 3,
        type: 'user/message',
        payload: { content: 'cccccccc' },
      },
    ]

    expect(suffixStartIndexForTokens(events, 3)).toBe(1)
    expect(resolveCompactKeep(events, { keepTokens: 3 })).toBe(2)
    expect(resolveCompactKeep(events, { keep: 10 })).toBe(3)
    expect(resolveCompactKeep(events, {})).toBe(0)
  })

  it('compacts by keepTokens and preserves projected history', async () => {
    const log = new SessionLog(await tempFile('compact-tokens.jsonl'))
    await log.append('user/message', { content: 'aaaa' })
    await log.append('user/message', { content: 'bbbbbbbb' })
    await log.append('user/message', { content: 'cccccccc' })
    const before = await log.deriveMessages()

    const count = await log.compact({ keepTokens: 3 })
    expect(count).toBe(7)
    expect(await log.deriveMessages()).toEqual(before)

    const events = await log.read()
    expect(events.at(-2)!.type).toBe('checkpoint')
    expect(events
      .filter(event => event.type === 'user/message')
      .map(event => (event.payload as { content: string }).content))
      .toEqual([
      'aaaa',
      'bbbbbbbb',
      'cccccccc',
    ])
    const checkpoint = events.at(-2)!.payload as { messages: ModelMessage[]; surfaceOp?: string }
    expect(checkpoint.messages).toEqual([
      { role: 'user', content: 'aaaa' },
      { role: 'user', content: 'bbbbbbbb' },
      { role: 'user', content: 'cccccccc' },
    ])
    expect(checkpoint.surfaceOp).toBe('replace')
  })
})

