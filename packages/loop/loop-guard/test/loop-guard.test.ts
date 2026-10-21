import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { tools } from '@tnega/tools'
import { agents, type AgentRegistry, type LLMAdapter, type LLMCompletion } from '@tnega/agent'
import {
  detectLoop,
  loopGuard,
  LOOP_GUARD_ATTEMPTS_NAME,
  LOOP_GUARD_NAME,
  LOOP_GUARD_PARK_NAME,
  LOOP_GUARD_REFLECT_NAME,
  type LoopEntry,
  type LoopGuardConfig,
} from '../src/index.js'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

interface Request { names: string[]; tools: number }

/**
 * Runs one turn. `reply` sees each request (model-visible authors and whether
 * tools were offered) and answers it, so a test can play a looping model.
 */
async function run(
  reply: (request: Request, index: number) => LLMCompletion,
  config: LoopGuardConfig = {},
  agentConfig: { maxSteps?: number } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-loop-guard-'))
  dirs.push(dir)
  const root = new Context()
  await root.plugin(tools)
  await root.plugin(agents)
  await root.plugin(loopGuard, config)
  const toolService = root.get('tools')
  toolService.register({
    schema: { name: 'search', description: 'search', parameters: { type: 'object', properties: { q: { type: 'string' } } } },
    execute: () => 'no results',
  })
  toolService.register({
    schema: { name: 'read', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
    execute: (input: unknown) => `contents of ${JSON.stringify(input)}`,
  })
  toolService.register({
    schema: { name: 'write_file', description: 'write', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } },
    execute: () => 'written',
  })
  toolService.register({
    schema: { name: 'fail', description: 'fail', parameters: { type: 'object', properties: { n: { type: 'number' } } } },
    execute: (input: unknown) => { throw new Error(`connection refused on attempt ${JSON.stringify(input)}`) },
  })
  const requests: Request[] = []
  const llm: LLMAdapter = {
    async complete(messages, offered) {
      const request = { names: messages.map(message => message.name ?? message.role), tools: offered.length }
      requests.push(request)
      return reply(request, requests.length - 1)
    },
  }
  const registry = root.get('agents') as AgentRegistry
  const handle = await registry.create({ id: 'looper', file: join(dir, 's.jsonl'), llm, ...agentConfig })
  await handle.agent.followup({ text: 'find the answer' })
  await handle.agent.whenIdle()
  const events = await handle.agent.session.read()
  const guard = events.flatMap(event => event.type === 'user/message' && event.payload.name?.startsWith('plugin:loop-guard')
    ? [event.payload.name]
    : [])
  const finishes = events.flatMap(event => event.type === 'turn/end' ? [event.payload.finishReason] : [])
  return { root, handle, requests, guard, finishes }
}

const call = (name: string, args: unknown, id = Math.random().toString(36).slice(2)): LLMCompletion => ({
  content: '', toolCalls: [{ id, name, arguments: args }], finishReason: 'tool_calls',
})
const answer = (content: string): LLMCompletion => ({ content, finishReason: 'stop' })

const entry = (action: string, outcome = `${action}-out`, error?: string): LoopEntry => ({
  action, outcome, label: `${action}()`, ...(error ? { error } : {}),
})
const limits = { window: 12, sameResult: 3, sameCall: 6, sameError: 3, sameMessage: 3 }

describe('loop guard detectors', () => {
  it('flags the same call with the same result, but not a call that keeps learning', () => {
    expect(detectLoop([entry('a'), entry('a'), entry('a')], [], limits)?.kind).toBe('same-result')
    // Polling that returns something new each time is not a loop yet.
    expect(detectLoop([entry('a', '1'), entry('a', '2'), entry('a', '3')], [], limits)).toBeUndefined()
    expect(detectLoop(Array.from({ length: 6 }, (_, i) => entry('a', String(i))), [], limits)?.kind).toBe('same-call')
  })

  it('flags a repeated error, an A→B cycle and a repeated message', () => {
    const errors = [entry('a', '1', 'E: x'), entry('b', '2', 'E: x'), entry('c', '3', 'E: x')]
    expect(detectLoop(errors, [], limits)?.kind).toBe('same-error')
    expect(detectLoop([entry('a'), entry('b'), entry('a'), entry('b')], [], limits)?.kind).toBe('cycle')
    // Different results each lap: only three full laps count as a cycle.
    const laps = (n: number) => Array.from({ length: n * 2 }, (_, i) => entry(i % 2 ? 'b' : 'a', String(i)))
    expect(detectLoop(laps(2), [], limits)).toBeUndefined()
    expect(detectLoop(laps(3), [], limits)?.kind).toBe('cycle')
    expect(detectLoop([], ['h', 'h', 'h'], limits)?.kind).toBe('same-message')
    expect(detectLoop([entry('a'), entry('b'), entry('c')], ['h', 'i', 'h'], limits)).toBeUndefined()
  })
})

describe('loop guard', () => {
  it('nudges, then asks for reflection, then parks a turn that keeps repeating itself', async () => {
    const { requests, guard, finishes, handle } = await run(request => request.tools
      ? call('search', { q: 'the answer' })
      : answer('I searched for the answer several times and found nothing. Can you point me to where it lives?'))
    expect(guard).toEqual([LOOP_GUARD_NAME, LOOP_GUARD_REFLECT_NAME, LOOP_GUARD_PARK_NAME])
    // The parked step was offered no tools, and the model reported instead.
    expect(requests.at(-1)?.tools).toBe(0)
    expect(requests.at(-1)?.names.at(-1)).toBe(LOOP_GUARD_PARK_NAME)
    expect(requests.length).toBeLessThan(15)
    expect(finishes).toEqual(['stop'])
    await handle.dispose()
  })

  it('leaves a long turn alone while it keeps making progress', async () => {
    const { guard, finishes, requests, handle } = await run((_request, index) => index < 80
      ? call('write_file', { path: `f${index}.txt`, content: 'x' })
      : answer('Wrote all the files.'))
    expect(guard).toEqual([])
    // Past the old cap of 64 steps: the backstop is far higher.
    expect(requests).toHaveLength(81)
    expect(finishes).toEqual(['stop'])
    await handle.dispose()
  })

  it('fires the watchdog after many steps without progress, even when every call is new', async () => {
    const { guard, handle } = await run((_request, index) => index < 12
      ? call('read', { path: `f${index}.txt` })
      : answer('Read them all.'), { stallSteps: 5 })
    expect(guard[0]).toBe(LOOP_GUARD_NAME)
    await handle.dispose()
  })

  it('catches the same error over and over', async () => {
    const { guard, handle } = await run((request, index) => request.tools
      ? call('fail', { n: index })
      : answer('The server keeps refusing the connection. Is it running?'))
    expect(guard).toEqual([LOOP_GUARD_NAME, LOOP_GUARD_REFLECT_NAME, LOOP_GUARD_PARK_NAME])
    await handle.dispose()
  })

  it('parks a turn that crosses its soft token limit', async () => {
    const { guard, requests, handle } = await run((request, index) => request.tools
      ? { ...call('read', { path: `f${index}` }), usage: { promptTokens: 600, completionTokens: 10 } }
      : answer('Stopping: I have read a lot and need to know which part matters.'), { maxTurnTokens: 2000 })
    expect(guard).toEqual([LOOP_GUARD_PARK_NAME])
    expect(requests.at(-1)?.tools).toBe(0)
    await handle.dispose()
  })

  it('keeps the caller\'s own step limit', async () => {
    const { requests, finishes, handle } = await run((_request, index) => call('write_file', { path: `f${index}` }), {}, { maxSteps: 3 })
    // Three steps plus the one the budget grants for a report, then the cap.
    expect(requests.length).toBeLessThanOrEqual(4)
    expect(finishes).toEqual(['max_steps'])
    await handle.dispose()
  })

  it('re-sends failed attempts after a compaction', async () => {
    const { root, handle } = await run((request, index) => request.tools && index < 2
      ? call('fail', { n: index })
      : answer('It failed twice; stopping.'))
    await root.parallel('agent/context-compacted', { agentId: 'looper', summary: 's', sourceMessages: [], llm: { complete: async () => answer('') } })
    const events = await handle.agent.session.read()
    const staged = JSON.stringify(events.filter(event => JSON.stringify(event).includes(LOOP_GUARD_ATTEMPTS_NAME)))
    expect(staged).toContain('connection refused')
    await handle.dispose()
  })
})
