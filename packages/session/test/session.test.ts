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
  SESSION_FORMAT_VERSION,
  assistantStreams,
  checkSessionInvariants,
  estimateContextUsage,
  estimateEventTokens,
  estimateMessageTokens,
  deriveEventMessage,
  foldRequestContext,
  foldRequestHeader,
  foldSessionMeta,
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
  transcriptEvents,
  type ModelMessage,
  type AssistantStreamRecord,
  type PlanPayload,
  type SessionEvent,
} from '../src/index.js'

type DynamicContext = Context & {
  [key: string]: unknown
}

const dynamic = (ctx: Context): DynamicContext => ctx as unknown as DynamicContext

const dirs: string[] = []

it('replays copied committed assistant streams in durable order including shadowed messages', async () => {
  const log = new SessionLog(await tempFile('reconnect-streams.jsonl'))
  await log.init()
  await log.append('turn/start', { turn: 1 })
  await log.append('step/start', { turn: 1, step: 0 })
  await log.append('assistant/chunk', { id: 'legacy', content: 'not replayed' })
  await log.append('assistant/attempt', { turn: 1, step: 0, stream: [
    { time: 10, chunk: { type: 'stream_error', error: { message: 'failed' } } },
  ] })
  const message = await log.append('assistant/message', { content: 'done', stream: [
    { time: 9, chunk: { type: 'toolcall_end', id: 'call', index: 0, name: 'tool', arguments: { nested: ['original'] } } },
  ] })
  await log.append('assistant/message', { content: 'legacy message' })
  await log.append('checkpoint', { messages: [{ role: 'system', content: 'summary' }],
    surfaceOp: { op: 'replace', start: message.seq, end: message.seq } })
  const events = await log.read()
  const streams = assistantStreams(events)
  expect(streams).toEqual([
    [{ time: 10, chunk: { type: 'stream_error', error: { message: 'failed' } } }],
    [{ time: 9, chunk: { type: 'toolcall_end', id: 'call', index: 0, name: 'tool', arguments: { nested: ['original'] } } }],
  ])
  const chunk = streams[1]?.[0]?.chunk
  if (chunk?.type === 'toolcall_end') {
    const args = chunk.arguments
    if (typeof args === 'object' && args !== null && 'nested' in args && Array.isArray(args.nested)) {
      args.nested[0] = 'mutated'
    }
  }
  streams[0]?.splice(0)
  expect(assistantStreams(events)).toEqual([
    [{ time: 10, chunk: { type: 'stream_error', error: { message: 'failed' } } }],
    [{ time: 9, chunk: { type: 'toolcall_end', id: 'call', index: 0, name: 'tool', arguments: { nested: ['original'] } } }],
  ])
  await log.close()
})

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
      payload: { formatVersion: SESSION_FORMAT_VERSION },
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
  it('persists both atomic inbox claim counts as one log-only event', async () => {
    const file = await tempFile('atomic-inbox-claim.jsonl')
    const log = new SessionLog(file)
    await log.init()
    await log.append('agent/inbox/spliced', {
      target: 'all', deleteCounts: { nextTurn: 1, nextStep: 2 },
    })
    await log.close()
    const reopened = new SessionLog(file)
    await reopened.init()
    expect((await reopened.read()).filter(event => event.type === 'agent/inbox/spliced'))
      .toMatchObject([{ payload: { target: 'all', deleteCounts: { nextTurn: 1, nextStep: 2 } } }])
    expect(await reopened.deriveMessages()).toEqual([])
    await reopened.close()
  })

  it('rejects v9 logs without rewriting their atomic clear semantics', async () => {
    const file = await tempFile('v9-inbox.jsonl')
    const original = `${JSON.stringify({ id: 'v9', seq: 1, ts: 1, type: 'meta', payload: { formatVersion: 9 } })}\n`
    await writeFile(file, original, 'utf8')
    const log = new SessionLog(file)
    await expect(log.init()).rejects.toBeInstanceOf(SessionFormatError)
    expect(await readFile(file, 'utf8')).toBe(original)
  })

  it('preserves a failed attempt stream across reopen without adding model history', async () => {
    const file = await tempFile('assistant-attempt.jsonl')
    const log = new SessionLog(file)
    await log.append('user/message', { content: 'hello' })
    await log.append('turn/start', { turn: 1 })
    await log.append('step/start', { turn: 1, step: 0 })
    const stream: AssistantStreamRecord[] = [
      { time: 100, chunk: { type: 'message_start', id: 'm1', model: 'test' } },
      { time: 101, chunk: { type: 'message_delta', id: 'm1', delta: 'part' } },
      { time: 101, chunk: { type: 'message_delta', id: 'm1', delta: 'ial' } },
      { time: 102, chunk: { type: 'toolcall_start', id: 'c1', index: 0, name: 'read' } },
      { time: 103, chunk: { type: 'toolcall_end', id: 'c1', index: 0, name: 'read', arguments: { path: 'a' } } },
      { time: 104, chunk: { type: 'stream_error', error: { name: 'NetworkError', message: 'connection lost' } } },
    ]
    const attempt = await log.append('assistant/attempt', { turn: 1, step: 0, stream })
    stream[1] = { time: 999, chunk: { type: 'message_delta', id: 'm1', delta: 'mutated' } }
    expect(estimateEventTokens(attempt)).toBe(0)
    expect(deriveEventMessage(attempt)).toBeNull()
    expect(await log.deriveMessages()).toEqual([{ role: 'user', content: 'hello' }])
    await log.append('step/end', { turn: 1, step: 0, finishReason: 'error' })
    await log.append('turn/end', { turn: 1, finishReason: 'error' })
    await log.close()

    const reopened = new SessionLog(file)
    await reopened.init()
    const events = await reopened.read()
    expect(events.find(event => event.type === 'assistant/attempt')).toEqual(attempt)
    expect(attempt.payload).toMatchObject({
      turn: 1,
      step: 0,
      stream: [
        { time: 100, chunk: { type: 'message_start', id: 'm1', model: 'test' } },
        { time: 101, chunk: { type: 'message_delta', id: 'm1', delta: 'part' } },
        { time: 101, chunk: { type: 'message_delta', id: 'm1', delta: 'ial' } },
        { time: 102, chunk: { type: 'toolcall_start', id: 'c1', index: 0, name: 'read' } },
        { time: 103, chunk: { type: 'toolcall_end', id: 'c1', index: 0, name: 'read', arguments: { path: 'a' } } },
        { time: 104, chunk: { type: 'stream_error', error: { name: 'NetworkError', message: 'connection lost' } } },
      ],
    })
    expect(attempt.surfaceOp).toBeUndefined()
    expect(await reopened.deriveMessages()).toEqual([{ role: 'user', content: 'hello' }])
    expect(await reopened.runInvariants()).toEqual([])
    await reopened.close()
  })

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
  it('keeps a message fork valid after a failed attempt and reopen', async () => {
    const log = new SessionLog(await tempFile('fork-at-attempt.jsonl'))
    await log.append('user/message', { content: 'hello' })
    await log.append('turn/start', { turn: 1 })
    await log.append('step/start', { turn: 1, step: 0 })
    const attempt = await log.append('assistant/attempt', {
      turn: 1,
      step: 0,
      stream: [{ time: 100, chunk: { type: 'stream_error', error: { message: 'retry me' } } }],
    })
    const answer = await log.append('assistant/message', { content: 'hi' })
    await log.append('step/end', { turn: 1, step: 0, finishReason: 'stop' })
    await log.append('turn/end', { turn: 1, finishReason: 'stop' })

    const selected = await log.forkAt(answer.id)
    expect(checkSessionInvariants(selected)).toEqual([])
    expect(selected.map(event => event.type)).toEqual(['user/message', 'assistant/message'])
    expect((await log.read()).find(event => event.id === attempt.id)).toEqual(attempt)
    const file = await tempFile('fork-at-attempt-child.jsonl')
    await writeV5(file, selected)
    const fork = new SessionLog(file)
    await fork.init()
    expect(await fork.runInvariants()).toEqual([])
    expect(await fork.deriveMessages()).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ])
    await fork.close()
    await log.close()
  })

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
    await log.append('user/message', { content: 'still here' })
    await log.append('assistant/message', { content: 'kept reply' })
    await log.compact({
      messages: [{ role: 'system', content: 'summarized' }],
      keep: 2,
    })
    const next = await log.append('user/message', { content: 'recent' })

    const selected = await log.forkAt(next.id)
    expect(selected.map(event => event.type)).toEqual([
      'user/message',
      'assistant/message',
      'user/message',
      'assistant/message',
      'compaction/start',
      'checkpoint',
      'compaction/end',
      'user/message',
    ])
    expect(selected.map(event => (event.payload as { content?: string }).content))
      .toEqual([
        'old user',
        'old reply',
        'still here',
        'kept reply',
        undefined,
        undefined,
        undefined,
        'recent',
      ])
    const checkpoint = selected.find(event => event.type === 'checkpoint')!
    const payload = checkpoint.payload as {
      messages?: ModelMessage[]
      surfaceOp?: { op: string; start: number; end: number }
    }
    expect(payload.messages).toEqual([{ role: 'system', content: 'summarized' }])
    expect(payload.surfaceOp).toMatchObject({ op: 'replace' })
  })
})

describe('SessionLog deriveMessages', () => {
  it('projects user, assistant, tool call and tool result history', async () => {
    const log = new SessionLog(await tempFile('derive.jsonl'))
    await log.append('user/message', { content: 'calculate 1+2' })
    await log.append('assistant/message', {
      content: '',
      toolCalls: [{ id: 'c1', name: 'add', arguments: { a: 1, b: 2 } }],
    })
    // `tool/call` is log-only: it correlates the pair but never re-enters the
    // transcript on its own.
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
    await log.append('assistant/message', {
      content: '',
      toolCalls: [{ id: 'c1', name: 'boom', arguments: {} }],
    })
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

  it('rejects v7 logs without rewriting or migrating them', async () => {
    const file = await tempFile('format-v7.jsonl')
    const raw = `${JSON.stringify({
      id: 'meta-v7', seq: 1, ts: 1, type: 'meta', payload: { formatVersion: 7 },
    })}\n`
    await writeFile(file, raw, 'utf8')
    await expect(new SessionLog(file).init()).rejects.toBeInstanceOf(SessionFormatError)
    expect(await readFile(file, 'utf8')).toBe(raw)
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
  it('keeps derived history when nothing is worth shadowing', async () => {
    const log = new SessionLog(await tempFile('compact-none.jsonl'))
    await log.append('user/message', { content: '1+2' })
    await log.append('assistant/message', { content: '3' })
    const before = await log.deriveMessages()

    // Without a replacement prefix there is no summary to write, so compaction
    // is a no-op: no events are appended and the model view is unchanged.
    const count = await log.compact({ summary: 'structured summary', tokensBefore: 120 })
    expect(count).toBe((await log.read()).length)
    expect(await log.deriveMessages()).toEqual(before)
    expect((await log.read()).filter(event => event.type === 'checkpoint')).toHaveLength(0)
  })

  it('appends an append-only compaction and keeps the recent tail', async () => {
    const log = new SessionLog(await tempFile('compact-v7.jsonl'))
    for (const [role, content] of [
      ['user', 'a'],
      ['assistant', 'A'],
      ['user', 'recent long'],
      ['assistant', 'tail reply'],
    ] as const) {
      if (role === 'user') await log.append('user/message', { content })
      else await log.append('assistant/message', { content })
    }
    const beforeCount = (await log.read()).length

    const count = await log.compact({
      keepTokens: 6,
      summary: 'structured summary',
      tokensBefore: 120,
      messages: [{ role: 'system', content: 'structured summary' }],
    })
    expect(count).toBe(beforeCount + 3)

    const events = await log.read()
    // The three compaction events are appended last, in order, while the older
    // messages physically stay in place before them (append-only, seqs intact).
    expect(events.slice(-3).map(event => event.type)).toEqual([
      'compaction/start',
      'checkpoint',
      'compaction/end',
    ])
    const startIndex = events.findIndex(event => event.type === 'compaction/start')
    expect(events.findIndex(event => event.type === 'assistant/message' && event.payload.content === 'a')).toBeLessThan(startIndex)
    expect(events.findIndex(event => event.type === 'assistant/message' && event.payload.content === 'A')).toBeLessThan(startIndex)

    const checkpoint = events.at(-2)!.payload as {
      messages: ModelMessage[]
      summary?: string
      tokensBefore?: number
      surfaceOp?: { op: string; start: number; end: number }
    }
    expect(checkpoint.messages).toEqual([{ role: 'system', content: 'structured summary' }])
    expect(checkpoint.summary).toBe('structured summary')
    expect(checkpoint.tokensBefore).toBe(120)
    expect(checkpoint.surfaceOp).toMatchObject({ op: 'replace' })

    // Model view = replacement prefix + the recent user turn.
    expect(await log.deriveMessages()).toEqual([
      { role: 'system', content: 'structured summary' },
      { role: 'user', content: 'recent long' },
      { role: 'assistant', content: 'tail reply' },
    ])
  })

  it('can append after compact with a fresh seq', async () => {
    const log = new SessionLog(await tempFile('compact-append.jsonl'))
    await log.append('user/message', { content: 'a' })
    await log.append('assistant/message', { content: 'b' })
    await log.append('user/message', { content: 'recent' })
    await log.append('assistant/message', { content: 'r' })
    await log.compact({ messages: [{ role: 'system', content: 'S' }], keepTokens: 3 })

    const event = await log.append('user/message', { content: 'c' })
    // seq continues contiguously from the appended log — nothing was rewritten.
    expect(event.seq).toBe((await log.read()).length)
    expect((await log.deriveMessages()).map(message => message.content)).toEqual([
      'S',
      'recent',
      'r',
      'c',
    ])
  })

  it('keeps derive, surface and invariants consistent after a v6 compact', async () => {
    const file = await tempFile('compact-consistency.jsonl')
    const log = new SessionLog(file)
    await log.append('turn/start', { turn: 1, input: 'go', reason: 'user' })
    await log.append('step/start', { turn: 1, step: 0 })
    await log.append('user/message', { content: 'old1' })
    await log.append('assistant/message', { content: '' })
    await log.append('tool/call', { id: 'c1', name: 'add', arguments: {} })
    await log.append('tool/result', { id: 'r1', toolCallId: 'c1', name: 'add', ok: true, output: 3 })
    await log.append('step/end', { turn: 1, step: 0 })
    await log.append('turn/end', { turn: 1, finishReason: 'stop' })
    await log.append('turn/start', { turn: 2, input: 'recent', reason: 'user' })
    await log.append('user/message', { content: 'recent request' })
    await log.append('assistant/message', { content: 'tail reply' })
    await log.append('turn/end', { turn: 2, finishReason: 'stop' })

    await log.compact({
      keepTokens: 1,
      summary: 'S',
      messages: [{ role: 'system', content: 'S' }],
    })
    const events = await log.read()
    expect(checkSessionInvariants(events)).toEqual([])

    // derive == surface projection: both carry the replacement prefix + tail.
    const derive = await log.deriveMessages()
    expect(derive.some(message => message.content === 'S')).toBe(true)
    expect(derive.some(message => message.content === 'tail reply')).toBe(true)

    // Close + reopen: the reordered file reloads with balanced structure and
    // the same model view.
    await log.close()
    const reopened = new SessionLog(file)
    await reopened.init()
    expect(checkSessionInvariants(await reopened.read())).toEqual([])
    const reDerive = await reopened.deriveMessages()
    expect(reDerive.some(message => message.content === 'S')).toBe(true)
    expect(reDerive.some(message => message.content === 'tail reply')).toBe(true)
    await reopened.close()
  })

  it('supports nested compaction of an already-compacted log', async () => {
    const file = await tempFile('compact-nested.jsonl')
    const log = new SessionLog(file)
    for (let index = 0; index < 6; index += 1) {
      await log.append('user/message', { content: `q${index}` })
      await log.append('assistant/message', { content: `a${index}` })
    }
    await log.compact({ keepTokens: 1, summary: 'S1', messages: [{ role: 'system', content: 'S1' }] })
    await log.append('user/message', { content: 'fresh' })
    await log.append('assistant/message', { content: 'fresh reply' })
    await log.compact({ keepTokens: 1, summary: 'S2', messages: [{ role: 'system', content: 'S2' }] })

    const events = await log.read()
    expect(checkSessionInvariants(events)).toEqual([])
    expect(events.filter(event => event.type === 'checkpoint')).toHaveLength(2)
    const derive = await log.deriveMessages()
    expect(derive.some(message => message.content === 'S2')).toBe(true)
    expect(derive.some(message => message.content === 'fresh reply')).toBe(true)

    await log.close()
    const reopened = new SessionLog(file)
    await reopened.init()
    expect(checkSessionInvariants(await reopened.read())).toEqual([])
    await reopened.close()
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
    const log = new SessionLog(file, (type, payload) => {
      broadcasts.push(`${type}:${(payload as { type?: string }).type ?? 'flush'}`)
    })
    await log.append('user/message', { content: 'a' })
    await log.flush()

    expect(broadcasts).toEqual(['event:user/message', 'flush:flush'])
  })

  it('keeps custom broadcast precedence when a publication Context is provided', async () => {
    const root = new Context()
    const contextEvents: unknown[] = []
    const broadcasts: string[] = []
    root.on('session/event', (event: SessionEvent) => { contextEvents.push(event) })
    root.on('session/flush', (payload: unknown) => { contextEvents.push(payload) })
    const log = new SessionLog(await tempFile('broadcast-owner-override.jsonl'), type => {
      broadcasts.push(type)
    }, root)
    try {
      await log.append('user/message', { content: 'custom publication' })
      await log.flush()

      expect(broadcasts).toEqual(['event', 'flush'])
      expect(contextEvents).toEqual([])
    } finally {
      await log.close()
    }
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

describe('surface-node derivation', () => {
  it('projects an appended conversation exactly as recorded', async () => {
    const log = new SessionLog(await tempFile('surface-append.jsonl'))
    await log.append('user/message', { content: 'a' })
    await log.append('assistant/message', { content: 'A' })
    await log.append('user/message', { content: 'b' })
    await log.append('assistant/message', {
      content: 'B',
      toolCalls: [{ id: 't1', name: 'read', arguments: { file: 'x' } }],
    })
    await log.append('tool/result', {
      id: 'r1',
      toolCallId: 't1',
      name: 'read',
      ok: true,
      output: 'file body',
    })

    expect(await log.deriveMessages()).toEqual([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'A' },
      { role: 'user', content: 'b' },
      {
        role: 'assistant',
        content: 'B',
        tool_calls: [{ id: 't1', name: 'read', arguments: { file: 'x' } }],
      },
      { role: 'tool', content: 'file body', tool_call_id: 't1', name: 'read' },
    ])
  })

  it('skips a content-less assistant message that requested no tools', async () => {
    const log = new SessionLog(await tempFile('surface-empty-assistant.jsonl'))
    await log.append('user/message', { content: 'a' })
    await log.append('assistant/message', { content: '' })
    await log.append('user/message', { content: 'b' })

    expect(await log.deriveMessages()).toEqual([
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
    ])
  })

  it('compacts append-only: prefix + kept tail in surface order, seqs immutable', async () => {
    const file = await tempFile('compact-surface.jsonl')
    const log = new SessionLog(file)
    for (const [role, content] of [
      ['user', 'a'],
      ['assistant', 'A'],
      ['user', 'b'],
      ['assistant', 'B'],
      ['user', 'c'],
      ['assistant', 'C'],
    ] as const) {
      if (role === 'user') await log.append('user/message', { content })
      else await log.append('assistant/message', { content })
    }
    const before = await log.read()
    const beforeCount = before.length

    const count = await log.compact({
      messages: [{ role: 'system', content: 'summarized' }],
      keep: 2,
    })

    // Compaction only appended: seq stays a contiguous 1..n and the old head
    // messages physically precede the compaction markers in the file.
    expect(count).toBeGreaterThan(beforeCount)
    const events = await log.read()
    expect(events.map(event => event.seq)).toEqual(
      events.map((_, index) => index + 1),
    )
    const headIndex = events.findIndex(event => event.type === 'assistant/message' && event.payload.content === 'A')
    const checkpointIndex = events.findIndex(event => event.type === 'checkpoint')
    expect(headIndex).toBeGreaterThan(-1)
    expect(checkpointIndex).toBeGreaterThan(headIndex)

    expect(await log.deriveMessages()).toEqual([
      { role: 'system', content: 'summarized' },
      { role: 'user', content: 'c' },
      { role: 'assistant', content: 'C' },
    ])
    expect((await log.surfaceEvents()).map(event => event.type)).toEqual([
      'checkpoint',
      'user/message',
      'assistant/message',
    ])

    const reopened = new SessionLog(file)
    await reopened.init()
    expect(await reopened.deriveMessages()).toEqual([
      { role: 'system', content: 'summarized' },
      { role: 'user', content: 'c' },
      { role: 'assistant', content: 'C' },
    ])
  })

  it('nests a second compaction over an already-compacted session', async () => {
    const log = new SessionLog(await tempFile('compact-nested.jsonl'))
    for (const [role, content] of [
      ['user', 'a'],
      ['assistant', 'A'],
      ['user', 'b'],
      ['assistant', 'B'],
      ['user', 'c'],
      ['assistant', 'C'],
    ] as const) {
      if (role === 'user') await log.append('user/message', { content })
      else await log.append('assistant/message', { content })
    }
    await log.compact({ messages: [{ role: 'system', content: 'summary-1' }], keep: 2 })
    await log.append('user/message', { content: 'd' })
    await log.append('assistant/message', { content: 'D' })
    await log.compact({ messages: [{ role: 'system', content: 'summary-2' }], keep: 2 })

    expect(await log.deriveMessages()).toEqual([
      { role: 'system', content: 'summary-2' },
      { role: 'user', content: 'd' },
      { role: 'assistant', content: 'D' },
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

describe('durable meta patches', () => {
  it('folds the head meta plus later meta/patch events in order', async () => {
    const log = new SessionLog(await tempFile('meta-patch.jsonl'))
    await log.append('meta', {
      kind: 'session',
      title: 'before',
      agentType: 'general',
      mode: 'auto',
    })
    await log.append('meta/patch', { fields: ['title'], title: 'after' })
    await log.append('meta/patch', { fields: ['mode', 'agentType'], mode: 'execute', agentType: 'coding' })

    const events = await log.read()
    expect(foldSessionMeta(events)).toEqual({
      title: 'after',
      mode: 'execute',
      agentType: 'coding',
    })
    expect(await log.meta()).toEqual({
      title: 'after',
      mode: 'execute',
      agentType: 'coding',
    })
  })

  it('does not project meta/patch events into the model surface', async () => {
    const log = new SessionLog(await tempFile('meta-patch-surface.jsonl'))
    await log.append('user/message', { content: 'hello' })
    await log.append('meta/patch', { fields: ['title'], title: 't' })
    expect(await log.deriveMessages()).toEqual([{ role: 'user', content: 'hello' }])
    const events = await log.read()
    for (const event of events.filter(event => event.type === 'meta/patch')) {
      expect(estimateEventTokens(event)).toBe(0)
    }
  })

  it('rebuilds the folded metadata after reload', async () => {
    const file = await tempFile('meta-patch-reload.jsonl')
    const first = new SessionLog(file)
    await first.append('meta', {
      kind: 'session',
      title: 'a',
      agentType: 'general',
      mode: 'auto',
    })
    await first.append('meta/patch', { fields: ['title', 'mode'], title: 'b', mode: 'plan' })
    await first.close()

    const second = new SessionLog(file)
    expect(await second.meta()).toEqual({
      title: 'b',
      agentType: 'general',
      mode: 'plan',
    })
    await second.close()
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

  it('compacts by keepTokens and preserves the retained tail', async () => {
    const log = new SessionLog(await tempFile('compact-tokens.jsonl'))
    await log.append('user/message', { content: 'aaaa' })
    await log.append('user/message', { content: 'bbbbbbbb' })
    await log.append('user/message', { content: 'cccccccc' })

    const count = await log.compact({
      keepTokens: 3,
      messages: [{ role: 'system', content: 'summary' }],
    })
    expect(count).toBe(7)

    // Append-only: every original message stays in the log; only the head
    // (aaaa) left the surface.
    const events = await log.read()
    expect(events.at(-2)!.type).toBe('checkpoint')
    expect(events
      .filter(event => event.type === 'user/message')
      .map(event => (event.payload as { content: string }).content))
      .toEqual(['aaaa', 'bbbbbbbb', 'cccccccc'])
    const checkpoint = events.at(-2)!.payload as {
      messages: ModelMessage[]
      surfaceOp?: { op: string; start: number; end: number }
    }
    expect(checkpoint.messages).toEqual([{ role: 'system', content: 'summary' }])
    expect(checkpoint.surfaceOp).toMatchObject({ op: 'replace' })
    expect(await log.deriveMessages()).toEqual([
      { role: 'system', content: 'summary' },
      { role: 'user', content: 'bbbbbbbb' },
      { role: 'user', content: 'cccccccc' },
    ])
  })
})


describe('transcriptEvents', () => {
  it('keeps shadowed history for the web while derive hides it from the model', async () => {
    const log = new SessionLog(await tempFile('transcript.jsonl'))
    for (const [role, content] of [
      ['user', 'a'],
      ['assistant', 'A'],
      ['user', 'b'],
      ['assistant', 'B'],
    ] as const) {
      if (role === 'user') await log.append('user/message', { content })
      else await log.append('assistant/message', { content })
    }
    await log.compact({
      messages: [{ role: 'system', content: 'summarized' }],
      summary: 'summarized',
      keep: 2,
    })

    // Model view: shadowed history gone, prefix + kept tail remain.
    expect((await log.deriveMessages()).map(message => message.content))
      .toEqual(['summarized', 'b', 'B'])

    // Human transcript: nothing is hidden; the checkpoint is a marker in place.
    const transcript = transcriptEvents(await log.read())
    const types = transcript
      .filter(event => event.type !== 'meta')
      .map(event => event.type)
    expect(types).toEqual([
      'user/message',
      'assistant/message',
      'checkpoint',
      'user/message',
      'assistant/message',
    ])
    const contents = transcript
      .filter(event => event.type === 'user/message')
      .map(event => (event.payload as { content: string }).content)
    expect(contents).toEqual(['a', 'b'])
    expect(transcript.find(event => event.type === 'checkpoint')?.payload)
      .toMatchObject({ summary: 'summarized' })
  })

  it('expands nested compactions into a readable marker chain', async () => {
    const log = new SessionLog(await tempFile('transcript-nested.jsonl'))
    for (const [role, content] of [
      ['user', 'a'],
      ['assistant', 'A'],
      ['user', 'b'],
      ['assistant', 'B'],
      ['user', 'c'],
      ['assistant', 'C'],
    ] as const) {
      if (role === 'user') await log.append('user/message', { content })
      else await log.append('assistant/message', { content })
    }
    await log.compact({ messages: [{ role: 'system', content: 's1' }], summary: 's1', keep: 2 })
    await log.append('user/message', { content: 'd' })
    await log.append('assistant/message', { content: 'D' })
    await log.compact({ messages: [{ role: 'system', content: 's2' }], summary: 's2', keep: 2 })

    const transcript = transcriptEvents(await log.read())
    const markers = transcript.filter(event => event.type === 'checkpoint')
    // The second compaction superseded the first, so only the live checkpoint
    // remains as a marker — but the first one's full history is still shown
    // above it (recursively expanded), nothing for the reader is lost.
    expect(markers.map(event => (event.payload as { summary?: string }).summary))
      .toEqual(['s2'])
    const users = transcript
      .filter(event => event.type === 'user/message')
      .map(event => (event.payload as { content: string }).content)
    expect(users).toEqual(['a', 'b', 'c', 'd'])
  })
})
