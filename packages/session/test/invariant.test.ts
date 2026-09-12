import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  InvariantRegistry,
  assertInvariants,
  InvariantViolationError,
  type InvariantContext,
} from '@tnega/core'
import {
  SESSION_FORMAT_VERSION,
  SessionLog,
  checkBalancedSteps,
  checkBalancedToolCalls,
  checkBalancedTurns,
  checkMonotonicSeq,
  checkSessionInvariants,
  type SessionEvent,
  type AssistantStreamRecord,
} from '@tnega/session'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempFile(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-session-invariant-'))
  dirs.push(dir)
  return join(dir, name)
}

function turnStart(turn: number, seq: number): SessionEvent {
  return { id: `t${turn}-s`, seq, ts: seq, type: 'turn/start', payload: { turn } }
}

function turnEnd(turn: number, seq: number): SessionEvent {
  return { id: `t${turn}-e`, seq, ts: seq, type: 'turn/end', payload: { turn } }
}

function stepStart(turn: number, step: number, seq: number): SessionEvent {
  return { id: `s${turn}-${step}-s`, seq, ts: seq, type: 'step/start', payload: { turn, step } }
}

function stepEnd(turn: number, step: number, seq: number): SessionEvent {
  return { id: `s${turn}-${step}-e`, seq, ts: seq, type: 'step/end', payload: { turn, step } }
}

function call(id: string, seq: number): SessionEvent {
  return {
    id: `call-${id}`,
    seq,
    ts: seq,
    type: 'tool/call',
    payload: { id, name: 'read_file', arguments: {} },
  }
}

function result(id: string, seq: number): SessionEvent {
  return {
    id: `result-${id}`,
    seq,
    ts: seq,
    type: 'tool/result',
    payload: { id, toolCallId: id, name: 'read_file', ok: true, output: 'x' },
  }
}

function attempt(turn: number, step: number, seq: number, stream: AssistantStreamRecord[] = []): SessionEvent {
  return { id: `attempt-${seq}`, seq, ts: seq, type: 'assistant/attempt', payload: { turn, step, stream } }
}

describe('assistant attempt invariants', () => {
  it('rejects an Error instance that would lose its message in JSONL', () => {
    const events = [
      turnStart(1, 1), stepStart(1, 0, 2),
      attempt(1, 0, 3, [{ time: 100, chunk: { type: 'stream_error', error: new Error('connection lost') } }]),
      stepEnd(1, 0, 4), turnEnd(1, 5),
    ]
    expect(checkSessionInvariants(events).map(failure => failure.name)).toContain('assistant/attempt-invalid-stream')
  })

  it('accepts multiple settled attempts in one step, including an empty stream', () => {
    expect(checkSessionInvariants([
      turnStart(1, 1), stepStart(1, 0, 2), attempt(1, 0, 3),
      attempt(1, 0, 4, [{ time: 100, chunk: { type: 'message_stop', id: 'm1', finishReason: 'cancelled' } }]),
      stepEnd(1, 0, 5), turnEnd(1, 6),
    ])).toEqual([])
  })

  it.each([
    { label: 'without a step', events: [turnStart(1, 1), attempt(1, 0, 2), turnEnd(1, 3)] },
    { label: 'after step end', events: [turnStart(1, 1), stepStart(1, 0, 2), stepEnd(1, 0, 3), attempt(1, 0, 4), turnEnd(1, 5)] },
    { label: 'in the wrong step', events: [turnStart(1, 1), stepStart(1, 0, 2), attempt(1, 1, 3), stepEnd(1, 0, 4), turnEnd(1, 5)] },
    { label: 'in the wrong turn', events: [turnStart(1, 1), stepStart(1, 0, 2), attempt(2, 0, 3), stepEnd(1, 0, 4), turnEnd(1, 5)] },
    { label: 'after turn end', events: [turnStart(1, 1), stepStart(1, 0, 2), turnEnd(1, 3), attempt(1, 0, 4), stepEnd(1, 0, 5)] },
  ])('rejects an attempt $label', ({ events }) => {
    expect(checkSessionInvariants(events).map(failure => failure.name)).toContain('assistant/attempt-without-open-step')
  })

  it.each([
    { label: 'missing array', stream: null },
    { label: 'null record', stream: [null] },
    { label: 'negative timestamp', stream: [{ time: -1, chunk: { type: 'message_delta', id: 'm1', delta: 'x' } }] },
    { label: 'fractional timestamp', stream: [{ time: 0.5, chunk: { type: 'message_delta', id: 'm1', delta: 'x' } }] },
    { label: 'unknown provider event', stream: [{ time: 1, chunk: { type: 'provider_chunk' } }] },
    { label: 'missing delta', stream: [{ time: 1, chunk: { type: 'message_delta', id: 'm1' } }] },
    { label: 'invalid start model', stream: [{ time: 1, chunk: { type: 'message_start', id: 'm1', model: 2 } }] },
    { label: 'negative tool index', stream: [{ time: 1, chunk: { type: 'toolcall_start', id: 'c1', index: -1, name: 'read' } }] },
    { label: 'missing tool arguments', stream: [{ time: 1, chunk: { type: 'toolcall_end', id: 'c1', index: 0, name: 'read' } }] },
    { label: 'unknown finish reason', stream: [{ time: 1, chunk: { type: 'message_stop', id: 'm1', finishReason: 'unknown' } }] },
    { label: 'missing error message', stream: [{ time: 1, chunk: { type: 'stream_error', error: { name: 'Error' } } }] },
  ])('rejects a malformed persisted stream: $label', async ({ stream }) => {
    const file = await tempFile('invalid-attempt.jsonl')
    const events = [
      { id: 'meta', seq: 1, ts: 1, type: 'meta', payload: { formatVersion: SESSION_FORMAT_VERSION } },
      turnStart(1, 2), stepStart(1, 0, 3),
      { id: 'attempt', seq: 4, ts: 4, type: 'assistant/attempt', payload: { turn: 1, step: 0, stream } },
      stepEnd(1, 0, 5), turnEnd(1, 6),
    ]
    await writeFile(file, events.map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8')
    const log = new SessionLog(file)
    await log.init()
    expect((await log.runInvariants()).map(failure => failure.name)).toContain('assistant/attempt-invalid-stream')
    await log.close()
  })
})

describe('session invariant companion', () => {
  it('accepts a balanced lifecycle stream', () => {
    const events = [
      turnStart(1, 1),
      stepStart(1, 0, 2),
      call('c1', 3),
      result('c1', 4),
      stepEnd(1, 0, 5),
      turnEnd(1, 6),
    ]
    expect(checkSessionInvariants(events)).toEqual([])
    expect(checkBalancedTurns(events)).toEqual([])
    expect(checkBalancedSteps(events)).toEqual([])
    expect(checkBalancedToolCalls(events)).toEqual([])
    expect(checkMonotonicSeq(events)).toEqual([])
  })

  it('flags an unclosed turn and step', () => {
    const events = [
      turnStart(1, 1),
      stepStart(1, 0, 2),
      turnStart(2, 3),
    ]
    const names = checkSessionInvariants(events).map(failure => failure.name)
    expect(names).toContain('turn/start-without-end')
    expect(names).toContain('step/start-without-end')
  })

  it('flags an unpaired tool call and an orphan result', () => {
    const unpaired = [call('c1', 1), call('c2', 2), result('c1', 3)]
    const orphan = [result('orphan', 1)]

    const names = checkBalancedToolCalls(unpaired).map(failure => failure.name)
    expect(names).toContain('tool/call-without-result')

    const orphanNames = checkBalancedToolCalls(orphan).map(failure => failure.name)
    expect(orphanNames).toContain('tool/result-without-call')
  })

  it('flags a step/end that never had a step/start', () => {
    const violations = checkBalancedSteps([stepEnd(9, 0, 1)])
    expect(violations[0]?.name).toBe('step/end-without-start')
  })

  it('flags non-monotonic seq', () => {
    const events = [turnStart(1, 3), turnEnd(1, 2)]
    const violations = checkMonotonicSeq(events)
    expect(violations[0]?.name).toBe('non-monotonic-seq')
  })

  it('reports balanced stream after SessionLog repair on load', async () => {
    const file = await tempFile('repaired.jsonl')
    const meta: SessionEvent = {
      id: 'meta-format',
      seq: 1,
      ts: 1,
      type: 'meta',
      payload: { formatVersion: SESSION_FORMAT_VERSION },
    }
    const raw = [
      meta,
      turnStart(1, 2),
      stepStart(1, 0, 3),
      call('c1', 4),
    ]
    const { writeFile } = await import('node:fs/promises')
    await writeFile(file, raw.map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8')

    const log = new SessionLog(file)
    await log.init()
    expect(await log.runInvariants()).toEqual([])
    await log.close()
  })
})

describe('InvariantRegistry', () => {
  it('registers, dedupes, runs all and throws on violation', async () => {
    const registry = new InvariantRegistry()
    const disposeA = registry.register({
      name: 'always-ok',
      describe: () => 'never fires',
      check: () => [],
    })
    const disposeB = registry.register({
      name: 'always-violates',
      describe: () => 'fires every time',
      check: () => ['broken relationship'],
    })

    expect(registry.has('always-ok')).toBe(true)
    expect(() => registry.register({
      name: 'always-ok',
      describe: () => 'dup',
      check: () => [],
    })).toThrow('already registered')

    const context: InvariantContext = { events: [{ kind: 'x' }] }
    const violations = await registry.runAll(context)
    expect(violations).toEqual(['broken relationship'])
    expect(() => assertInvariants(violations)).toThrow(InvariantViolationError)

    disposeB()
    expect(await registry.runAll(context)).toEqual([])
    disposeA()
  })
})
