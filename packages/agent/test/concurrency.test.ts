import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { tools, type ToolDefinition } from '@tnega/tools'
import { agents, type AgentRegistry, type AgentStepEndEvent, type LLMAdapter, type LLMCompletion } from '../src/index.js'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

interface Call {
  id: string
  name: string
  arguments: Record<string, unknown>
}

/**
 * One turn whose first completion asks for every call at once, then answers.
 * The calls of one assistant message are exactly the batch the scheduler groups.
 */
async function runOneStep(register: (registry: Context['tools']) => ToolDefinition[], calls: Call[]): Promise<{
  step: AgentStepEndEvent
  started: string[]
}> {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-parallel-'))
  dirs.push(dir)
  const root = new Context()
  await root.plugin(tools)
  await root.plugin(agents)
  const registry = root.get('tools')
  for (const tool of register(registry)) registry.register(tool)

  const steps: AgentStepEndEvent[] = []
  root.on('agent/step-end', (event: AgentStepEndEvent) => { steps.push(event) })
  let turn = 0
  const llm: LLMAdapter = {
    async complete() {
      const completion: LLMCompletion = turn++ === 0
        ? { content: '', toolCalls: calls.map(call => ({ id: call.id, name: call.name, arguments: call.arguments })), finishReason: 'tool_calls' }
        : { content: 'done', finishReason: 'stop' }
      return completion
    },
  }
  const handle = await (root.get('agents') as AgentRegistry).create({ id: 'parallel', file: join(dir, 's.jsonl'), llm })
  try {
    await handle.agent.followup({ text: 'go' })
    await handle.agent.whenIdle()
  } finally {
    await handle.dispose()
    await root.fiber.dispose()
  }
  const first = steps[0]
  if (!first) throw new Error('no step recorded')
  return { step: first, started: first.calls.map(entry => entry.call.id) }
}

function probe(
  name: string,
  tracker: { inFlight: number; peak: number },
  options: { ms?: number; fail?: boolean; safe?: boolean; log?: string[] } = {},
): ToolDefinition {
  const ms = options.ms ?? 40
  return {
    schema: { name, description: name, parameters: { type: 'object', properties: {} } },
    ...(options.safe === false ? {} : { isConcurrencySafe: () => true }),
    async execute() {
      tracker.inFlight += 1
      tracker.peak = Math.max(tracker.peak, tracker.inFlight)
      options.log?.push(`${name}:in`)
      await delay(ms)
      tracker.inFlight -= 1
      options.log?.push(`${name}:out`)
      if (options.fail) throw new Error(`${name} failed`)
      return name
    },
  }
}

describe('tool call concurrency', () => {
  it('runs concurrency-safe calls of one message at the same time', async () => {
    const tracker = { inFlight: 0, peak: 0 }
    await runOneStep(
      () => [probe('read_a', tracker), probe('read_b', tracker)],
      [{ id: 'c1', name: 'read_a', arguments: {} }, { id: 'c2', name: 'read_b', arguments: {} }],
    )
    // Serial execution peaks at one: the second call starts after the first ends.
    expect(tracker.peak).toBe(2)
  })

  it('keeps results attached to the call that asked for them, whatever finished first', async () => {
    const tracker = { inFlight: 0, peak: 0 }
    const { step } = await runOneStep(
      () => [probe('slow_read', tracker, { ms: 80 }), probe('fast_read', tracker, { ms: 5 })],
      [{ id: 'c1', name: 'slow_read', arguments: {} }, { id: 'c2', name: 'fast_read', arguments: {} }],
    )
    // The fast one finishes first; its result still belongs to the second call.
    expect(step.calls.map(entry => entry.call.id)).toEqual(['c1', 'c2'])
    expect(step.calls.map(entry => entry.result.output)).toEqual(['slow_read', 'fast_read'])
    expect(step.calls.every(entry => entry.result.callId === entry.call.id)).toBe(true)
  })

  it('treats a tool that declares nothing as a fence', async () => {
    const tracker = { inFlight: 0, peak: 0 }
    const log: string[] = []
    await runOneStep(
      () => [
        probe('read_before', tracker, { ms: 40, log }),
        probe('write_middle', tracker, { ms: 10, safe: false, log }),
        probe('read_after', tracker, { ms: 10, log }),
      ],
      [
        { id: 'c1', name: 'read_before', arguments: {} },
        { id: 'c2', name: 'write_middle', arguments: {} },
        { id: 'c3', name: 'read_after', arguments: {} },
      ],
    )
    // Nothing overlaps the exclusive call, on either side of it.
    expect(tracker.peak).toBe(1)
    expect(log).toEqual([
      'read_before:in', 'read_before:out',
      'write_middle:in', 'write_middle:out',
      'read_after:in', 'read_after:out',
    ])
  })

  it('treats an unknown tool name as a fence instead of grouping it', async () => {
    const tracker = { inFlight: 0, peak: 0 }
    const { step } = await runOneStep(
      () => [probe('read_a', tracker)],
      [
        { id: 'c1', name: 'read_a', arguments: {} },
        { id: 'c2', name: 'no_such_tool', arguments: {} },
      ],
    )
    expect(tracker.peak).toBe(1)
    expect(step.calls[1]?.result.ok).toBe(false)
  })

  it('lets a failing call finish the batch instead of cancelling its siblings', async () => {
    const tracker = { inFlight: 0, peak: 0 }
    const { step } = await runOneStep(
      () => [probe('read_ok', tracker, { ms: 40 }), probe('read_broken', tracker, { ms: 5, fail: true })],
      [{ id: 'c1', name: 'read_ok', arguments: {} }, { id: 'c2', name: 'read_broken', arguments: {} }],
    )
    expect(step.calls.map(entry => entry.result.ok)).toEqual([true, false])
    expect(step.calls[1]?.result.error?.message).toContain('read_broken failed')
  })

  it('honours a condition that depends on the arguments', async () => {
    const tracker = { inFlight: 0, peak: 0 }
    const conditional: ToolDefinition = {
      schema: { name: 'maybe_read', description: 'read', parameters: { type: 'object', properties: {} } },
      isConcurrencySafe: (input: unknown) => (input as { read?: boolean }).read === true,
      async execute(input) {
        tracker.inFlight += 1
        tracker.peak = Math.max(tracker.peak, tracker.inFlight)
        await delay(30)
        tracker.inFlight -= 1
        return input
      },
    }
    await runOneStep(
      () => [conditional],
      [{ id: 'c1', name: 'maybe_read', arguments: { read: true } }, { id: 'c2', name: 'maybe_read', arguments: { read: true } }],
    )
    expect(tracker.peak).toBe(2)
    tracker.peak = 0
    await runOneStep(
      () => [conditional],
      [{ id: 'c1', name: 'maybe_read', arguments: { read: false } }, { id: 'c2', name: 'maybe_read', arguments: { read: false } }],
    )
    expect(tracker.peak).toBe(1)
  })
})
