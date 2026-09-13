import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Context, FiberState } from '@tnega/core'
import { SessionLog, session, type ModelMessage, type SessionEvent } from '@tnega/session'
import { tools, ToolsService, type ToolDefinition } from '@tnega/tools'

import {
  agent,
  AgentError,
  AgentInbox,
  llmService,
  type LlmService,
  type AgentService,
  type AgentStreamEvent,
  type AgentLoop,
  type AgentPreStepEvent,
  type AgentRequestEvent,
  type AgentRequestErrorEvent,
  type AgentRunResult,
  type AgentToolCallEvent,
  type AgentToolResultEvent,
  type LLMAdapter,
  type LLMCompletion,
  type LLMStreamEvent,
  type LLMStreamRequestEvent,
  type LLMToolCall,
} from '../src/index.js'

type DynamicContext = Context & {
  [key: string]: unknown
}

const dynamic = (ctx: Context): DynamicContext => ctx as unknown as DynamicContext

const dirs: string[] = []

async function tempFile(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-agent-'))
  dirs.push(dir)
  return join(dir, name)
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function fakeLLM(sequence: Array<Omit<LLMCompletion, 'finishReason'> & { finishReason: LLMCompletion['finishReason'] }>): {
  adapter: LLMAdapter
  calls: Array<{ messages: ModelMessage[]; tools: readonly ToolDefinition[] }>
} {
  const calls: Array<{ messages: ModelMessage[]; tools: readonly ToolDefinition[] }> = []
  let index = 0
  return {
    adapter: {
      async complete(messages, availableTools) {
        calls.push({ messages: [...messages], tools: [...availableTools] })
        const completion = sequence[Math.min(index, sequence.length - 1)]!
        index += 1
        return completion
      },
    },
    calls,
  }
}

function toolCall(id: string, name: string, argumentsValue: unknown): LLMToolCall {
  return { id, name, arguments: argumentsValue }
}

function streamingLLM(events: readonly LLMStreamEvent[]): LLMAdapter {
  return {
    complete: async () => {
      throw new Error('complete should not be used')
    },
    stream: async function* () {
      yield* events
    },
  }
}

async function collectStream(
  stream: AsyncGenerator<AgentStreamEvent, AgentRunResult, void>,
): Promise<{ events: AgentStreamEvent[]; result: AgentRunResult }> {
  const events: AgentStreamEvent[] = []
  let result: AgentRunResult | undefined
  const iterator = stream[Symbol.asyncIterator]()
  while (true) {
    const next = await iterator.next()
    if (next.done) {
      result = next.value
      break
    }
    events.push(next.value)
  }
  return { events, result: result! }
}

function addTool(): ToolDefinition {
  return {
    schema: { name: 'add', description: 'add two numbers' },
    execute: (input) => {
      const values = input as { a: number; b: number }
      return values.a + values.b
    },
  }
}

describe('AgentInbox', () => {
  it('pushes, claims and peeks inputs', () => {
    const inbox = new AgentInbox()
    inbox.push({ text: 'a' })
    inbox.push({ text: 'b' })

    expect(inbox.size).toBe(2)
    expect(inbox.peek()).toEqual({ text: 'a' })
    expect(inbox.claim()).toEqual({ text: 'a' })
    expect(inbox.size).toBe(1)
    expect(inbox.claim()).toEqual({ text: 'b' })
    expect(inbox.claim()).toBeUndefined()
  })

  it('stores injected context separately from the queue', () => {
    const inbox = new AgentInbox()
    inbox.inject('runId', 'r1')
    inbox.inject('budget', 3)

    const injected = inbox.injected()
    expect(injected.get('runId')).toBe('r1')
    expect(injected.get('budget')).toBe(3)
    expect(inbox.size).toBe(0)
  })

  it('returns a copy of injected context', () => {
    const inbox = new AgentInbox()
    inbox.inject('runId', 'r1')
    const injected = new Map(inbox.injected())
    injected.set('runId', 'mutated')
    expect(inbox.injected().get('runId')).toBe('r1')
  })
})

describe('agent service wiring', () => {
  it('stays pending until session and tools are available', async () => {
    const root = new Context()
    const { adapter } = fakeLLM([{ content: 'hi', finishReason: 'stop' }])
    const fiber = root.plugin(agent, { llm: adapter })
    await fiber
    expect(fiber.state).toBe(FiberState.PENDING)

    await root.plugin(session, { file: await tempFile('pending.jsonl') })
    await root.plugin(tools)
    await fiber
    expect(fiber.state).toBe(FiberState.ACTIVE)
  })

  it('exposes a replaceable agentLoop service', async () => {
    const root = new Context()
    const expected: AgentRunResult = {
      input: { text: 'custom' },
      output: 'custom loop',
      finishReason: 'stop',
      steps: [],
      messages: [],
    }
    const fiber = root.plugin((ctx) => {
      ctx.provide('agentLoop', async () => expected)
    })
    await fiber

    const loop = root.get('agentLoop') as AgentLoop
    await expect(loop()).resolves.toEqual(expected)
  })

  it('requires an LLM adapter before running', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('no-llm.jsonl') })
    await root.plugin(tools)
    await root.plugin(agent)

    const loop = root.get('agentLoop') as AgentLoop
    await expect(loop({ text: 'hi' })).rejects.toThrow(AgentError)
  })
})

describe('agent loop', () => {
  it('runs a single step and emits the turn lifecycle', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('single.jsonl') })
    await root.plugin(tools)
    const { adapter, calls } = fakeLLM([{ content: 'hello', finishReason: 'stop' }])
    await root.plugin(agent, { llm: adapter })

    const events: string[] = []
    root.on('agent/start', () => events.push('start'))
    root.on('agent/turn-start', () => events.push('turn-start'))
    root.on('agent/step', () => events.push('step'))
    root.on('agent/turn-end', () => events.push('turn-end'))
    root.on('agent/end', () => events.push('end'))

    const loop = root.get('agentLoop') as AgentLoop
    const result = await loop({ text: 'hi' })

    expect(result.output).toBe('hello')
    expect(result.finishReason).toBe('stop')
    expect(result.turn).toBe(1)
    expect(result.steps).toHaveLength(1)
    expect(events).toEqual(['start', 'turn-start', 'step', 'turn-end', 'end'])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.messages).toEqual([{ role: 'user', content: 'hi' }])

    const log = dynamic(root).session as SessionLog
    expect(await log.deriveMessages()).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ])
  })

  it('claims the next input from the inbox', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('inbox.jsonl') })
    await root.plugin(tools)
    const { adapter } = fakeLLM([{ content: 'claimed', finishReason: 'stop' }])
    await root.plugin(agent, { llm: adapter })

    const inbox = dynamic(root).inbox as AgentInbox
    inbox.push({ text: 'queued' })
    const loop = root.get('agentLoop') as AgentLoop
    const result = await loop()

    expect(result.input).toEqual({ text: 'queued' })
    expect(inbox.size).toBe(0)
  })

  it('passes injected context into the start event', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('inject.jsonl') })
    await root.plugin(tools)
    const { adapter } = fakeLLM([{ content: 'ok', finishReason: 'stop' }])
    await root.plugin(agent, { llm: adapter })

    const inbox = dynamic(root).inbox as AgentInbox
    inbox.inject('runId', 'r1')
    let startInjected: ReadonlyMap<string, unknown> | undefined
    root.on('agent/start', (payload: { injected: ReadonlyMap<string, unknown> }) => {
      startInjected = payload.injected
    })

    const loop = root.get('agentLoop') as AgentLoop
    await loop({ text: 'go' })
    expect(startInjected?.get('runId')).toBe('r1')
  })

  it('runs a multi-step tool loop and reconstructs the model input', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('tool-loop.jsonl') })
    await root.plugin(tools)
    const toolService = dynamic(root).tools as ToolsService
    toolService.register(addTool())

    const { adapter, calls } = fakeLLM([
      {
        content: '',
        toolCalls: [toolCall('c1', 'add', { a: 1, b: 2 })],
        finishReason: 'tool_calls',
      },
      { content: '3', finishReason: 'stop' },
    ])
    await root.plugin(agent, { llm: adapter })

    const events: string[] = []
    const toolResults: string[] = []
    const coordinates: Array<{ turn?: number; step?: number }> = []
    root.on('agent/start', () => events.push('start'))
    root.on('agent/turn-start', () => events.push('turn-start'))
    root.on('agent/step', () => events.push('step'))
    root.on('agent/tool-call', (payload: AgentToolCallEvent) => {
      events.push(`tool-call:${payload.call.id}`)
      coordinates.push({
        ...(payload.turn !== undefined ? { turn: payload.turn } : {}),
        ...(payload.step !== undefined ? { step: payload.step } : {}),
      })
    })
    root.on('agent/tool-result', (payload: AgentToolResultEvent) => {
      events.push(`tool-result:${payload.result.output}`)
      toolResults.push(String(payload.result.output))
    })
    root.on('agent/turn-end', () => events.push('turn-end'))
    root.on('agent/end', () => events.push('end'))

    const loop = root.get('agentLoop') as AgentLoop
    const result = await loop({ text: '1+2' })

    expect(result.output).toBe('3')
    expect(result.finishReason).toBe('stop')
    expect(result.steps).toHaveLength(2)
    expect(result.steps[0]!.toolResults[0]!.output).toBe(3)
    expect(result.steps[0]!.toolResults[0]!.callId).toBe('c1')
    expect(toolResults).toEqual(['3'])
    expect(coordinates).toEqual([
      { turn: 1, step: 0 },
    ])
    expect(events).toEqual([
      'start',
      'turn-start',
      'step',
      'tool-call:c1',
      'tool-result:3',
      'step',
      'turn-end',
      'end',
    ])

    expect(calls).toHaveLength(2)
    expect(calls[0]!.messages).toEqual([{ role: 'user', content: '1+2' }])
    expect(calls[1]!.messages).toEqual([
      { role: 'user', content: '1+2' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', name: 'add', arguments: { a: 1, b: 2 } }],
      },
      { role: 'tool', content: '3', tool_call_id: 'c1', name: 'add' },
    ])
    expect(calls[1]!.tools.map(tool => tool.schema.name)).toContain('add')

    const log = dynamic(root).session as SessionLog
    expect(await log.deriveMessages()).toEqual([
      { role: 'user', content: '1+2' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', name: 'add', arguments: { a: 1, b: 2 } }],
      },
      { role: 'tool', content: '3', tool_call_id: 'c1', name: 'add' },
      { role: 'assistant', content: '3' },
    ])
  })

  it('stops after maxTurns when the model keeps requesting tools', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('max-turns.jsonl') })
    await root.plugin(tools)
    const toolService = dynamic(root).tools as ToolsService
    toolService.register(addTool())
    const { adapter } = fakeLLM([
      {
        content: '',
        toolCalls: [toolCall('c1', 'add', { a: 1, b: 2 })],
        finishReason: 'tool_calls',
      },
    ])
    await root.plugin(agent, { llm: adapter, maxTurns: 2 })

    const loop = root.get('agentLoop') as AgentLoop
    const result = await loop({ text: 'loop' })
    expect(result.steps).toHaveLength(2)
    expect(result.finishReason).toBe('max_turns')
  })

  it('runs a final turn when maxTurns ends on a tool call', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('max-turns-final.jsonl') })
    await root.plugin(tools)
    const toolService = dynamic(root).tools as ToolsService
    toolService.register(addTool())
    const { adapter, calls } = fakeLLM([
      {
        content: '',
        toolCalls: [toolCall('c1', 'add', { a: 1, b: 2 })],
        finishReason: 'tool_calls',
      },
      { content: '3', finishReason: 'stop' },
    ])
    await root.plugin(agent, { llm: adapter, maxTurns: 1 })

    const loop = root.get('agentLoop') as AgentLoop
    const result = await loop({ text: 'loop' })
    expect(result.steps).toHaveLength(2)
    expect(result.finishReason).toBe('stop')
    expect(result.output).toBe('3')
    expect(calls).toHaveLength(2)
    expect(calls[1]!.tools).toEqual([])

    const log = dynamic(root).session as SessionLog
    expect(await log.deriveMessages()).toEqual([
      { role: 'user', content: 'loop' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', name: 'add', arguments: { a: 1, b: 2 } }],
      },
      { role: 'tool', content: '3', tool_call_id: 'c1', name: 'add' },
      { role: 'assistant', content: '3' },
    ])
  })

  it('stops after maxSteps when the model keeps requesting tools', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('max-steps.jsonl') })
    await root.plugin(tools)
    const toolService = dynamic(root).tools as ToolsService
    toolService.register(addTool())
    const { adapter } = fakeLLM([
      {
        content: '',
        toolCalls: [toolCall('c1', 'add', { a: 1, b: 2 })],
        finishReason: 'tool_calls',
      },
    ])
    await root.plugin(agent, { llm: adapter, maxSteps: 2 })

    const loop = root.get('agentLoop') as AgentLoop
    const result = await loop({ text: 'loop' })
    expect(result.steps).toHaveLength(2)
    expect(result.finishReason).toBe('max_steps')
  })

  it('surfaces tool failures as tool messages', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('tool-error.jsonl') })
    await root.plugin(tools)
    const toolService = dynamic(root).tools as ToolsService
    toolService.register({
      schema: { name: 'fail', description: 'fail' },
      execute: () => {
        throw new Error('boom')
      },
    })

    const { adapter, calls } = fakeLLM([
      {
        content: '',
        toolCalls: [toolCall('c1', 'fail', {})],
        finishReason: 'tool_calls',
      },
      { content: 'failed', finishReason: 'stop' },
    ])
    await root.plugin(agent, { llm: adapter })

    const loop = root.get('agentLoop') as AgentLoop
    const result = await loop({ text: 'do it' })
    expect(result.output).toBe('failed')
    expect(calls[1]!.messages).toEqual([
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', name: 'fail', arguments: {} }],
      },
      {
        role: 'tool',
        content: 'error: boom',
        tool_call_id: 'c1',
        name: 'fail',
        toolOk: false,
        toolError: { name: 'Error', message: 'boom' },
      },
    ])
  })

  it('closes tool calls with a failed result when execution throws', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('tool-exec-error.jsonl') })
    await root.plugin(tools)
    const { adapter, calls } = fakeLLM([
      {
        content: '',
        toolCalls: [toolCall('c1', 'missing', {})],
        finishReason: 'tool_calls',
      },
      { content: 'recovered', finishReason: 'stop' },
    ])
    await root.plugin(agent, { llm: adapter })

    const loop = root.get('agentLoop') as AgentLoop
    const result = await loop({ text: 'do it' })

    expect(result.output).toBe('recovered')
    expect(calls[1]!.messages).toEqual([
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', name: 'missing', arguments: {} }],
      },
      {
        role: 'tool',
        content: 'error: tool not found: missing',
        tool_call_id: 'c1',
        name: 'missing',
        toolOk: false,
        toolError: {
          name: 'ToolNotFoundError',
          message: 'tool not found: missing',
        },
      },
    ])

    const log = dynamic(root).session as SessionLog
    const events = await log.read()
    const results = events.filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(1)
    expect(results[0]!.payload).toMatchObject({
      id: 'c1',
      toolCallId: 'c1',
      name: 'missing',
      ok: false,
      error: {
        name: 'ToolNotFoundError',
        message: 'tool not found: missing',
      },
    })
  })

  it('aborts the loop when the signal is already aborted', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('abort.jsonl') })
    await root.plugin(tools)
    const { adapter } = fakeLLM([{ content: 'never', finishReason: 'stop' }])
    await root.plugin(agent, { llm: adapter })

    const controller = new AbortController()
    controller.abort()
    const loop = root.get('agentLoop') as AgentLoop
    const result = await loop({ text: 'go' }, { signal: controller.signal })
    expect(result.steps).toHaveLength(0)
    expect(result.finishReason).toBe('cancelled')
  })

  it('settles a failed stream once without adding its prefix to model history', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('attempt-failure.jsonl') })
    await root.plugin(tools)
    await root.plugin(agent, { llm: {
      complete: async () => { throw new Error('unused') },
      async *stream() {
        yield { type: 'message_delta', id: 'failed', delta: 'discarded' }
        throw new Error('connection lost')
      },
    } satisfies LLMAdapter })
    const service = root.get('agent') as AgentService
    const log = root.get('session') as SessionLog
    const events: AgentStreamEvent[] = []
    await expect((async () => {
      for await (const event of service.runStream({ text: 'go' })) events.push(event)
    })()).rejects.toThrow('connection lost')
    const attempts = (await log.read()).filter(event => event.type === 'assistant/attempt')
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.payload).toMatchObject({ turn: 1, step: 0, stream: [
      { time: expect.any(Number), chunk: { type: 'message_delta', id: 'failed', delta: 'discarded' } },
      { time: expect.any(Number), chunk: { type: 'stream_error', error: { message: 'connection lost' } } },
    ] })
    const frames = events.filter(event => event.type === 'assistant/stream').map(event => event.frame)
    expect(frames.map(frame => frame.type)).toEqual(['start', 'chunk', 'chunk', 'end'])
    expect(frames.at(-1)).toMatchObject({ outcome: {
      kind: 'committed', eventType: 'assistant/attempt', seq: attempts[0]?.seq,
    } })
    expect(await log.deriveMessages()).toEqual([{ role: 'user', content: 'go' }])
    expect(await log.runInvariants()).toEqual([])
    await log.close()
  })

  it('routes an error stop through request recovery without committing a message', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('attempt-error-stop.jsonl') })
    await root.plugin(tools)
    let streams = 0
    await root.plugin(agent, { llm: {
      complete: async () => { throw new Error('unused') },
      async *stream() {
        streams += 1
        if (streams === 1) {
          yield { type: 'message_delta', id: 'failed', delta: 'discarded' }
          yield { type: 'message_stop', id: 'failed', finishReason: 'error' }
          return
        }
        yield { type: 'message_delta', id: 'ok', delta: 'recovered' }
        yield { type: 'message_stop', id: 'ok', finishReason: 'stop' }
      },
    } satisfies LLMAdapter })
    let recoveries = 0
    root.on('agent/request-error', async () => { recoveries += 1; return { kind: 'retry' } })
    const service = root.get('agent') as AgentService
    const { result } = await collectStream(service.runStream({ text: 'go' }))
    const log = root.get('session') as SessionLog
    expect(recoveries).toBe(1)
    expect(result.output).toBe('recovered')
    expect((await log.read()).filter(event => event.type === 'assistant/attempt')).toHaveLength(1)
    expect(await log.deriveMessages()).toEqual([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'recovered' },
    ])
    await log.close()
  })

  it('publishes an abandoned attempt end when terminal settlement rejects', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('attempt-abandoned.jsonl') })
    await root.plugin(tools)
    await root.plugin(agent, { llm: {
      complete: async () => { throw new Error('unused') },
      async *stream() { throw new Error('provider failed') },
    } satisfies LLMAdapter })
    const log = root.get('session') as SessionLog
    const append = log.append.bind(log)
    vi.spyOn(log, 'append').mockImplementation(async (type, payload) => {
      if ((type as string) === 'assistant/attempt') throw new Error('settlement failed')
      return append(type as never, payload as never)
    })
    const service = root.get('agent') as AgentService
    const events: AgentStreamEvent[] = []
    await expect((async () => {
      for await (const event of service.runStream({ text: 'go' })) events.push(event)
    })()).rejects.toThrow('settlement failed')
    expect(events.filter(event => event.type === 'assistant/stream').at(-1)).toMatchObject({ frame: {
      type: 'end', outcome: { kind: 'abandoned' },
    } })
    await log.close()
  })

  it('allocates distinct attempts and increasing lifecycle revisions across retries and runs', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('attempt-retry.jsonl') })
    await root.plugin(tools)
    let calls = 0
    await root.plugin(agent, { llm: {
      complete: async () => { throw new Error('unused') },
      async *stream() {
        calls += 1
        yield { type: 'message_delta', id: 'provider-reused-id', delta: calls === 1 ? 'failed' : 'ok' }
        if (calls === 1) throw new Error('retry')
        yield { type: 'message_stop', id: 'provider-reused-id', finishReason: 'stop' }
      },
    } satisfies LLMAdapter })
    root.on('agent/request-error', async () => ({ kind: 'retry' }))
    const service = root.get('agent') as AgentService
    const first = await collectStream(service.runStream({ text: 'go' }))
    const second = await collectStream(service.runStream({ text: 'again' }))
    const frames = [...first.events, ...second.events]
      .filter(event => event.type === 'assistant/stream').map(event => event.frame)
    const starts = frames.filter(frame => frame.type === 'start')
    expect(starts).toHaveLength(3)
    expect(new Set(starts.map(frame => frame.attemptId)).size).toBe(3)
    expect(frames.map(frame => frame.revision)).toEqual(Array.from({ length: frames.length }, (_, i) => i + 1))
    for (const start of starts) {
      const attempt = frames.filter(frame => frame.attemptId === start.attemptId)
      expect(attempt[0]?.type).toBe('start')
      expect(attempt.at(-1)?.type).toBe('end')
      expect(attempt.filter(frame => frame.type === 'chunk').map(frame => frame.index)).toEqual([0, 1])
    }
    const log = root.get('session') as SessionLog
    expect((await log.read()).filter(event => event.type === 'assistant/attempt')).toHaveLength(1)
    expect(first.result.output).toBe('ok')
    await log.close()
  })

  it.each(['throw', 'return'] as const)('settles cancellation without a message when the stream ends by %s', async (ending) => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile(`attempt-cancel-${ending}.jsonl`) })
    await root.plugin(tools)
    const controller = new AbortController()
    await root.plugin(agent, { llm: {
      complete: async () => { throw new Error('unused') },
      async *stream() {
        yield { type: 'message_start', id: 'cancelled' }
        controller.abort({ type: 'user' })
        if (ending === 'throw') throw new Error('aborted')
      },
    } satisfies LLMAdapter })
    const service = root.get('agent') as AgentService
    const { events, result } = await collectStream(service.runStream({ text: 'go' }, { signal: controller.signal }))
    const log = root.get('session') as SessionLog
    const attempts = (await log.read()).filter(event => event.type === 'assistant/attempt')
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.payload.stream.map(record => record.chunk.type)).toEqual(['message_start', 'stream_error'])
    expect(events.filter(event => event.type === 'assistant/stream').at(-1)).toMatchObject({ frame: {
      type: 'end', outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: attempts[0]?.seq },
    } })
    expect(result.finishReason).toBe('cancelled')
    expect(await log.deriveMessages()).toEqual([{ role: 'user', content: 'go' }])
    expect(await log.runInvariants()).toEqual([])
    await log.close()
  })

  it('publishes start before consuming and end only after committing the normalized assistant stream', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('attempt-success.jsonl') })
    await root.plugin(tools)
    const order: string[] = []
    await root.plugin(agent, { llm: {
      complete: async () => { throw new Error('unused') },
      async *stream() {
        order.push('consume')
        yield { type: 'message_delta', id: 'ok', delta: 'done' }
        yield { type: 'message_stop', id: 'ok', finishReason: 'stop' }
      },
    } satisfies LLMAdapter })
    const log = root.get('session') as SessionLog
    root.on('session/event', (event: SessionEvent) => {
      if (event.type === 'assistant/message') order.push('commit')
    })
    const service = root.get('agent') as AgentService
    for await (const event of service.runStream({ text: 'go' })) {
      if (event.type !== 'assistant/stream') continue
      const frame = event.frame
      order.push(frame.type)
      if (frame.type === 'end') {
        expect(frame.outcome.kind).toBe('committed')
        if (frame.outcome.kind !== 'committed') continue
        const { seq } = frame.outcome
        const committed = (await log.read()).find(item => item.seq === seq)
        expect(committed).toMatchObject({ type: 'assistant/message', payload: { content: 'done', stream: [
          { chunk: { type: 'message_delta', id: 'ok', delta: 'done' } },
          { chunk: { type: 'message_stop', id: 'ok', finishReason: 'stop' } },
        ] } })
      }
      if (frame.type === 'chunk' && frame.chunk.type === 'message_delta') frame.chunk.delta = 'consumer mutation'
    }
    expect(order).toEqual(['start', 'consume', 'chunk', 'chunk', 'commit', 'end'])
    expect((await log.read()).filter(event => event.type === 'assistant/attempt')).toHaveLength(0)
    expect(await log.deriveMessages()).toEqual([{ role: 'user', content: 'go' }, { role: 'assistant', content: 'done' }])
    await log.close()
  })

  it('streams LLM deltas and returns the collected result', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('stream.jsonl') })
    await root.plugin(tools)
    const adapter = streamingLLM([
      { type: 'message_start', id: 'm1', model: 'test-model' },
      { type: 'message_delta', id: 'm1', delta: 'hel' },
      { type: 'message_delta', id: 'm1', delta: 'lo' },
      { type: 'message_stop', id: 'm1', finishReason: 'stop' },
    ])
    await root.plugin(agent, { llm: adapter })

    const service = dynamic(root).agent as AgentService
    const { events, result } = await collectStream(service.runStream({ text: 'hi' }))

    expect(events.filter(event => event.type !== 'assistant/stream').map(event => event.type)).toEqual([
      'message_start',
      'message_delta',
      'message_delta',
      'message_stop',
      'run/end',
    ])
    expect(result.output).toBe('hello')
    expect(result.finishReason).toBe('stop')

    const log = dynamic(root).session as SessionLog
    expect(await log.deriveMessages()).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ])
  })

  it('streams tool start and end events around a tool call', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('stream-tools.jsonl') })
    await root.plugin(tools)
    const toolService = dynamic(root).tools as ToolsService
    toolService.register(addTool())
    let streamCalls = 0
    const adapter: LLMAdapter = {
      complete: async () => ({ content: '3', finishReason: 'stop' }),
      stream: async function* () {
        streamCalls += 1
        if (streamCalls === 1) {
          yield { type: 'message_start', id: 'm1' }
          yield {
            type: 'toolcall_start',
            id: 'c1',
            index: 0,
            name: 'add',
          }
          yield {
            type: 'toolcall_end',
            id: 'c1',
            index: 0,
            name: 'add',
            arguments: { a: 1, b: 2 },
          }
          yield { type: 'message_stop', id: 'm1', finishReason: 'tool_calls' }
          return
        }
        yield { type: 'message_start', id: 'm2' }
        yield { type: 'message_delta', id: 'm2', delta: '3' }
        yield { type: 'message_stop', id: 'm2', finishReason: 'stop' }
      },
    }
    await root.plugin(agent, { llm: adapter })

    const service = dynamic(root).agent as AgentService
    const { events, result } = await collectStream(service.runStream({ text: '1+2' }))

    expect(events.filter(event => event.type !== 'assistant/stream').map(event => event.type)).toEqual([
      'message_start',
      'toolcall_start',
      'toolcall_end',
      'message_stop',
      'tool/start',
      'tool/end',
      'message_start',
      'message_delta',
      'message_stop',
      'run/end',
    ])
    expect(result.output).toBe('3')
    expect(result.finishReason).toBe('stop')
    const toolEnd = events.find(event => event.type === 'tool/end')
    expect(toolEnd && toolEnd.type === 'tool/end' ? toolEnd.result.output : undefined).toBe(3)

    const log = dynamic(root).session as SessionLog
    expect(await log.deriveMessages()).toEqual([
      { role: 'user', content: '1+2' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', name: 'add', arguments: { a: 1, b: 2 } }],
      },
      { role: 'tool', content: '3', tool_call_id: 'c1', name: 'add' },
      { role: 'assistant', content: '3' },
    ])
  })

  it('lets llm/stream rewrite the final request before the adapter runs', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('stream-waterfall.jsonl') })
    await root.plugin(tools)
    const requests: ModelMessage[][] = []
    const adapter: LLMAdapter = {
      complete: async () => {
        throw new Error('complete should not be used')
      },
      stream: async function* (messages) {
        requests.push([...messages])
        yield { type: 'message_start', id: 'm1' }
        yield { type: 'message_delta', id: 'm1', delta: 'ok' }
        yield { type: 'message_stop', id: 'm1', finishReason: 'stop' }
      },
    }
    await root.plugin(agent, { llm: adapter })

    root.on('llm/stream', async (payload: LLMStreamRequestEvent, next) => {
      payload.messages = [
        ...payload.messages,
        { role: 'user', content: 'injected' },
      ]
      return next()
    })

    const service = dynamic(root).agent as AgentService
    const { result } = await collectStream(service.runStream({ text: 'go' }))
    expect(result.output).toBe('ok')
    expect(requests).toEqual([
      [
        { role: 'user', content: 'go' },
        { role: 'user', content: 'injected' },
      ],
    ])

    const log = dynamic(root).session as SessionLog
    expect(await log.deriveMessages()).toEqual([
      { role: 'user', content: 'go' },
      { role: 'user', content: 'injected' },
      { role: 'assistant', content: 'ok' },
    ])
  })

  it('lets llm/stream short-circuit without calling the adapter', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('stream-short-circuit.jsonl') })
    await root.plugin(tools)
    let adapterCalls = 0
    const adapter: LLMAdapter = {
      complete: async () => {
        throw new Error('complete should not be used')
      },
      stream: async function* () {
        adapterCalls += 1
        yield { type: 'message_start', id: 'adapter' }
        yield { type: 'message_delta', id: 'adapter', delta: 'never' }
        yield { type: 'message_stop', id: 'adapter', finishReason: 'stop' }
      },
    }
    await root.plugin(agent, { llm: adapter })

    root.on('llm/stream', async () => (async function* () {
      yield { type: 'message_start', id: 'wrapped' }
      yield { type: 'message_delta', id: 'wrapped', delta: 'wrapped' }
      yield { type: 'message_stop', id: 'wrapped', finishReason: 'stop' }
    })())

    const service = dynamic(root).agent as AgentService
    const { result } = await collectStream(service.runStream({ text: 'go' }))
    expect(result.output).toBe('wrapped')
    expect(adapterCalls).toBe(0)

    const log = dynamic(root).session as SessionLog
    const events = await log.read()
    expect(events.filter(event => event.type === 'assistant/chunk'))
      .toHaveLength(1)
    expect(await log.deriveMessages()).toEqual([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'wrapped' },
    ])
  })

  it('uses native stream for run when the adapter supplies one', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('run-native-stream.jsonl') })
    await root.plugin(tools)
    let completeCalls = 0
    let streamCalls = 0
    const adapter: LLMAdapter = {
      async complete() {
        completeCalls += 1
        return { content: 'fallback', finishReason: 'stop' }
      },
      async *stream() {
        streamCalls += 1
        yield { type: 'message_delta', id: 'native', delta: 'native output' }
        yield { type: 'message_stop', id: 'native', finishReason: 'stop' }
      },
    }
    await root.plugin(agent, { llm: adapter })

    const service = dynamic(root).agent as AgentService
    await expect(service.run({ text: 'go' })).resolves.toMatchObject({ output: 'native output' })
    expect(streamCalls).toBe(1)
    expect(completeCalls).toBe(0)
    const log = dynamic(root).session as SessionLog
    expect((await log.read()).filter(event => event.type === 'assistant/chunk')).toHaveLength(1)
  })

  it('routes non-streaming run calls through llm/stream', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('run-stream-waterfall.jsonl') })
    await root.plugin(tools)
    const requests: ModelMessage[][] = []
    const adapter: LLMAdapter = {
      async complete(messages) {
        requests.push([...messages])
        return { content: 'ok', finishReason: 'stop' }
      },
    }
    await root.plugin(agent, { llm: adapter })
    root.on('llm/stream', async (payload: LLMStreamRequestEvent, next) => {
      payload.messages = [...payload.messages, { role: 'user', content: 'routed' }]
      return next()
    })

    const service = dynamic(root).agent as AgentService
    await expect(service.run({ text: 'go' })).resolves.toMatchObject({ output: 'ok' })
    expect(requests).toEqual([[{ role: 'user', content: 'go' }, { role: 'user', content: 'routed' }]])
  })

  it('persists stream-rewritten tools and route configuration', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('stream-envelope.jsonl') })
    await root.plugin(tools)
    const registered = addTool()
    const toolService = dynamic(root).tools as ToolsService
    toolService.register(registered)
    const requests: Array<{ tools: readonly ToolDefinition[]; provider?: string; model?: string; temperature?: number }> = []
    const adapter: LLMAdapter = {
      async complete(_messages, availableTools, options) {
        requests.push({
          tools: [...availableTools],
          ...(options.provider ? { provider: options.provider } : {}),
          ...(options.model ? { model: options.model } : {}),
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        })
        return { content: 'ok', finishReason: 'stop' }
      },
    }
    await root.plugin(agent, { llm: adapter, assertReplayable: true })
    root.on('llm/stream', async (payload: LLMStreamRequestEvent, next) => {
      payload.tools = []
      payload.options = {
        ...payload.options,
        provider: 'routed-provider',
        model: 'routed-model',
        temperature: 0.25,
      }
      return next()
    })

    const service = dynamic(root).agent as AgentService
    await expect(service.run({ text: 'go' })).resolves.toMatchObject({ output: 'ok' })
    expect(requests).toEqual([{
      tools: [],
      provider: 'routed-provider',
      model: 'routed-model',
      temperature: 0.25,
    }])
    const log = dynamic(root).session as SessionLog
    expect(log.requestHeader()).toMatchObject({
      config: { provider: 'routed-provider', model: 'routed-model', temperature: 0.25 },
    })
    expect(log.requestHeader()?.tools).toBeUndefined()
    expect(log.requestContext()).toMatchObject({ provider: 'routed-provider', model: 'routed-model' })
  })

  it('persists the final routed request envelope after a retry', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('retry-final-envelope.jsonl') })
    await root.plugin(tools)
    let calls = 0
    const received: string[] = []
    const adapter: LLMAdapter = {
      async complete(_messages, _tools, options) {
        received.push(options.provider!)
        calls += 1
        if (calls === 1) throw new Error('retry me')
        return { content: 'recovered', finishReason: 'stop' }
      },
    }
    await root.plugin(agent, { llm: adapter, assertReplayable: true })
    let routes = 0
    root.on('llm/stream', async (payload: LLMStreamRequestEvent, next) => {
      routes += 1
      payload.options = { ...payload.options, provider: `route-${routes}` }
      return next()
    })
    root.on('agent/request-error', async () => ({ kind: 'retry' }))

    const service = dynamic(root).agent as AgentService
    await expect(service.run({ text: 'go' })).resolves.toMatchObject({ output: 'recovered' })
    expect(received).toEqual(['route-1', 'route-2'])
    const log = dynamic(root).session as SessionLog
    expect(log.requestHeader()).toMatchObject({ config: { provider: 'route-2' } })
    expect(log.requestContext()).toMatchObject({ provider: 'route-2' })
  })

  it('rebuilds retries from admitted messages without accumulating waterfall edits', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('retry-admitted-input.jsonl') })
    await root.plugin(tools)
    const requests: ModelMessage[][] = []
    const adapter: LLMAdapter = {
      async complete(messages) {
        requests.push(structuredClone([...messages]))
        if (requests.length === 1) throw new Error('retry once')
        return { content: 'recovered', finishReason: 'stop' }
      },
    }
    await root.plugin(agent, { llm: adapter })
    root.on('agent/pre-step', (payload: AgentPreStepEvent, next) => {
      payload.messages = [{ role: 'user', content: 'admitted' }]
      return next()
    })
    root.on('llm/stream', async (payload: LLMStreamRequestEvent, next) => {
      payload.messages[0]!.content += ' routed'
      payload.messages.push({ role: 'user', content: 'route hint' })
      return next()
    })
    root.on('agent/request-error', async (payload: AgentRequestErrorEvent) =>
      payload.attempt === 1 ? { kind: 'retry' } : undefined)

    const service = dynamic(root).agent as AgentService
    await expect(service.run({ text: 'go' })).resolves.toMatchObject({ output: 'recovered' })
    expect(requests).toEqual([
      [{ role: 'user', content: 'admitted routed' }, { role: 'user', content: 'route hint' }],
      [{ role: 'user', content: 'admitted routed' }, { role: 'user', content: 'route hint' }],
    ])
    const log = dynamic(root).session as SessionLog
    expect(await log.deriveMessages()).toEqual([
      { role: 'user', content: 'admitted routed' },
      { role: 'user', content: 'route hint' },
      { role: 'assistant', content: 'recovered' },
    ])
  })

  it('re-enters request waterfalls and recovers from the final failed envelope', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('retry-request-envelope.jsonl') })
    await root.plugin(tools)
    const registered = addTool()
    ;(dynamic(root).tools as ToolsService).register(registered)
    const received: Array<{ provider: string | undefined; model: string | undefined; temperature: number | undefined }> = []
    const adapter: LLMAdapter = {
      async complete(_messages, _tools, options) {
        received.push({ provider: options.provider, model: options.model, temperature: options.temperature })
        if (received.length === 1) throw new Error('route unavailable')
        return { content: 'recovered', finishReason: 'stop' }
      },
    }
    await root.plugin(agent, { llm: adapter })
    let requestCalls = 0
    root.on('agent/request', (payload: AgentRequestEvent, next) => {
      requestCalls += 1
      payload.options.provider = `proposal-${requestCalls}`
      payload.options.temperature = (payload.options.temperature ?? 0) + 0.25
      return next()
    })
    root.on('llm/stream', async (payload: LLMStreamRequestEvent, next) => {
      payload.tools = []
      payload.options = { ...payload.options, provider: `route-${requestCalls}`, model: `model-${requestCalls}` }
      return next()
    })
    const failures: AgentRequestErrorEvent[] = []
    root.on('agent/request-error', async (payload: AgentRequestErrorEvent) => {
      failures.push(payload)
      return payload.attempt === 1 ? { kind: 'retry' } : undefined
    })

    const service = dynamic(root).agent as AgentService
    await expect(service.run({ text: 'go' })).resolves.toMatchObject({ output: 'recovered' })
    expect(failures).toMatchObject([{
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      provider: 'route-1',
      model: 'model-1',
      options: { provider: 'route-1', model: 'model-1', temperature: 0.25 },
    }])
    expect(received).toEqual([
      { provider: 'route-1', model: 'model-1', temperature: 0.25 },
      { provider: 'route-2', model: 'model-2', temperature: 0.25 },
    ])
    expect(requestCalls).toBe(2)
    const log = dynamic(root).session as SessionLog
    expect(log.requestHeader()).toMatchObject({
      config: { provider: 'route-2', model: 'model-2', temperature: 0.25 },
    })
    expect(log.requestContext()).toMatchObject({ provider: 'route-2', model: 'model-2' })
  })

  it.each([
    { role: 'assistant', content: 'unowned answer' },
    { role: 'tool', content: 'unowned result', name: 'add', tool_call_id: 'ghost' },
  ] satisfies ModelMessage[])('rejects an unowned $role message without replay opt-in', async (message) => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile(`unowned-${message.role}.jsonl`) })
    await root.plugin(tools)
    const { adapter, calls } = fakeLLM([{ content: 'never', finishReason: 'stop' }])
    await root.plugin(agent, { llm: adapter })
    root.on('llm/stream', async (payload: LLMStreamRequestEvent, next) => {
      payload.messages.push(message)
      return next()
    })

    const service = dynamic(root).agent as AgentService
    await expect(service.run({ text: 'go' })).rejects.toThrow('not reconstructable')
    expect(calls).toHaveLength(0)
    const log = dynamic(root).session as SessionLog
    expect((await log.read()).filter(event => event.type === 'step/end' || event.type === 'turn/end'))
      .toMatchObject([{ payload: { finishReason: 'error' } }, { payload: { finishReason: 'error' } }])
    expect(await log.deriveMessages()).not.toContainEqual(message)
  })

  it('checks transcript ownership even when llm/stream short-circuits', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('unowned-short-circuit.jsonl') })
    await root.plugin(tools)
    const { adapter } = fakeLLM([{ content: 'never', finishReason: 'stop' }])
    await root.plugin(agent, { llm: adapter })
    root.on('llm/stream', async (payload: LLMStreamRequestEvent) => {
      payload.messages.push({ role: 'assistant', content: 'unowned' })
      return (async function* (): AsyncGenerator<LLMStreamEvent> {
        yield { type: 'message_stop', id: 'wrapped', finishReason: 'stop' }
      })()
    })

    const service = dynamic(root).agent as AgentService
    await expect(service.run({ text: 'go' })).rejects.toThrow('not reconstructable')
  })

  it.each(['append', 'replace', 'change-role'] as const)(
    'rejects a lazy short-circuit transcript %s before dispatch',
    async (mutation) => {
      const root = new Context()
      await root.plugin(session, { file: await tempFile(`lazy-short-circuit-${mutation}.jsonl`) })
      await root.plugin(tools)
      const requests: ModelMessage[][] = []
      const adapter: LLMAdapter = {
        async complete() {
          throw new Error('complete should not be used')
        },
        async *stream(messages) {
          requests.push(structuredClone([...messages]))
          yield { type: 'message_delta', id: 'never', delta: 'never' }
          yield { type: 'message_stop', id: 'never', finishReason: 'stop' }
        },
      }
      await root.plugin(agent, { llm: adapter })
      root.on('llm/stream', async (payload: LLMStreamRequestEvent) =>
        (async function* (): AsyncGenerator<LLMStreamEvent> {
          if (mutation === 'append') payload.messages.push({ role: 'assistant', content: 'unowned' })
          if (mutation === 'replace') payload.messages = [{ role: 'assistant', content: 'unowned' }]
          if (mutation === 'change-role') payload.messages[0]!.role = 'assistant'
          yield* adapter.stream!(payload.messages, payload.tools, payload.options)
        })())

      const service = dynamic(root).agent as AgentService
      await expect(service.run({ text: 'go' })).rejects.toThrow()
      expect(requests).toEqual([])
      const log = dynamic(root).session as SessionLog
      expect(await log.deriveMessages()).toEqual([{ role: 'user', content: 'go' }])
      expect((await log.read()).filter(event => event.type === 'step/end' || event.type === 'turn/end'))
        .toMatchObject([{ payload: { finishReason: 'error' } }, { payload: { finishReason: 'error' } }])
    },
  )

  it('rejects a lazy next stream transcript mutation before dispatch', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('lazy-next-stream.jsonl') })
    await root.plugin(tools)
    const { adapter, calls } = fakeLLM([{ content: 'never', finishReason: 'stop' }])
    await root.plugin(agent, { llm: adapter })
    root.on('llm/stream', async (payload: LLMStreamRequestEvent, next) => {
      const stream = await next()
      return (async function* (): AsyncGenerator<LLMStreamEvent> {
        payload.messages.push({ role: 'assistant', content: 'unowned' })
        yield* stream
      })()
    })

    const service = dynamic(root).agent as AgentService
    await expect(service.run({ text: 'go' })).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })

  it.each([
    'options-replace', 'provider', 'model', 'temperature',
    'tools-replace', 'tools-append', 'tool-schema', 'tool-parameters',
  ] as const)('rejects lazy short-circuit envelope mutation: %s', async mutation => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile(`lazy-envelope-${mutation}.jsonl`) })
    await root.plugin(tools)
    const tool = addTool()
    tool.schema.parameters = { type: 'object', required: ['value'] }
    ;(dynamic(root).tools as ToolsService).register(tool)
    let adapterCalls = 0
    const adapter: LLMAdapter = {
      async complete() { throw new Error('complete should not be used') },
      async *stream() {
        adapterCalls += 1
        yield { type: 'message_stop', id: 'never', finishReason: 'stop' }
      },
    }
    await root.plugin(agent, { llm: adapter })
    root.on('llm/stream', async (payload: LLMStreamRequestEvent) => {
      payload.options = {
        ...payload.options, provider: 'planned-provider', model: 'planned-model', temperature: 0.25,
      }
      return (async function* (): AsyncGenerator<LLMStreamEvent> {
        if (mutation === 'options-replace') payload.options = { provider: 'late-provider' }
        if (mutation === 'provider') payload.options.provider = 'late-provider'
        if (mutation === 'model') payload.options.model = 'late-model'
        if (mutation === 'temperature') payload.options.temperature = 1
        if (mutation === 'tools-replace') payload.tools = []
        if (mutation === 'tools-append') (payload.tools as ToolDefinition[]).push(addTool())
        if (mutation === 'tool-schema') payload.tools[0]!.schema.name = 'late-tool'
        if (mutation === 'tool-parameters') payload.tools[0]!.schema.parameters!.required!.push('late')
        yield* adapter.stream!(payload.messages, payload.tools, payload.options)
      })()
    })

    const service = dynamic(root).agent as AgentService
    await expect(service.run({ text: 'go' })).rejects.toThrow()
    expect(adapterCalls).toBe(0)
    const log = dynamic(root).session as SessionLog
    expect(log.requestHeader()).toMatchObject({
      config: { provider: 'planned-provider', model: 'planned-model', temperature: 0.25 },
      tools: [{ name: 'add', parameters: { required: ['value'] } }],
    })
    expect(log.requestContext()).toMatchObject({ provider: 'planned-provider', model: 'planned-model' })
  })

  it('dispatches a short-circuit stream with its persisted envelope and live abort signal', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('short-circuit-locked-envelope.jsonl') })
    await root.plugin(tools)
    const tool = addTool()
    ;(dynamic(root).tools as ToolsService).register(tool)
    const log = dynamic(root).session as SessionLog
    const controller = new AbortController()
    const observed: unknown[] = []
    const adapter: LLMAdapter = {
      async complete() { throw new Error('complete should not be used') },
      async *stream(messages, availableTools, options) {
        observed.push({
          messages: [...messages],
          tools: availableTools.map(item => item.schema),
          provider: options.provider,
          model: options.model,
          header: log.requestHeader(),
          context: log.requestContext(),
        })
        yield { type: 'message_delta', id: 'routed', delta: 'ok' }
        yield { type: 'message_stop', id: 'routed', finishReason: 'stop' }
      },
    }
    await root.plugin(agent, { llm: adapter })
    root.on('llm/stream', async (payload: LLMStreamRequestEvent) => {
      payload.options = { ...payload.options, provider: 'routed-provider', model: 'routed-model' }
      return (async function* (): AsyncGenerator<LLMStreamEvent> {
        yield* adapter.stream!(payload.messages, payload.tools, payload.options)
        controller.abort({ type: 'user' })
      })()
    })

    const service = dynamic(root).agent as AgentService
    await expect(service.run({ text: 'go' }, { signal: controller.signal }))
      .resolves.toMatchObject({ finishReason: 'cancelled' })
    expect(observed).toEqual([{
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'add', description: 'add two numbers' }],
      provider: 'routed-provider', model: 'routed-model',
      header: {
        reason: 'initial', config: { provider: 'routed-provider', model: 'routed-model' },
        tools: [{ name: 'add', description: 'add two numbers' }],
      },
      context: { provider: 'routed-provider', model: 'routed-model' },
    }])
    tool.schema.description = 'updated for a later request'
    expect((dynamic(root).tools as ToolsService).list()[0]!.schema.description)
      .toBe('updated for a later request')
  })

  it('makes each retry user and system replacement replayable before dispatch', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('retry-replaced-transcript.jsonl') })
    await root.plugin(tools)
    const log = dynamic(root).session as SessionLog
    const requests: ModelMessage[][] = []
    const replay: ModelMessage[][] = []
    const adapter: LLMAdapter = {
      async complete(messages) {
        requests.push(structuredClone([...messages]))
        replay.push(await log.deriveMessages())
        if (requests.length === 1) throw new Error('retry once')
        return { content: 'recovered', finishReason: 'stop' }
      },
    }
    await root.plugin(agent, { llm: adapter })
    let attempt = 0
    root.on('llm/stream', async (payload: LLMStreamRequestEvent, next) => {
      attempt += 1
      payload.messages = [
        { role: 'system', content: `system ${attempt}` },
        { role: 'user', content: `user ${attempt}` },
      ]
      return next()
    })
    root.on('agent/request-error', async (payload: AgentRequestErrorEvent) =>
      payload.attempt === 1 ? { kind: 'retry' } : undefined)

    const service = dynamic(root).agent as AgentService
    await expect(service.run({ text: 'go' })).resolves.toMatchObject({ output: 'recovered' })
    expect(requests).toEqual([
      [{ role: 'system', content: 'system 1' }, { role: 'user', content: 'user 1' }],
      [{ role: 'system', content: 'system 2' }, { role: 'user', content: 'user 2' }],
    ])
    expect(replay).toEqual(requests)
  })

  it.each([
    { retained: 'earlier', retainedIndex: 0 },
    { retained: 'go', retainedIndex: 2 },
  ])('can retry admitted history after a failed attempt retains only $retained', async ({ retained, retainedIndex }) => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('retry-omitted-history.jsonl') })
    await root.plugin(tools)
    const log = dynamic(root).session as SessionLog
    await log.append('user/message', { content: 'earlier' })
    await log.append('assistant/message', { content: 'earlier answer' })
    const requests: ModelMessage[][] = []
    const adapter: LLMAdapter = {
      async complete(messages) {
        requests.push(structuredClone([...messages]))
        if (requests.length === 1) throw new Error('retry once')
        return { content: 'recovered', finishReason: 'stop' }
      },
    }
    await root.plugin(agent, { llm: adapter })
    let attempt = 0
    root.on('llm/stream', async (payload: LLMStreamRequestEvent, next) => {
      attempt += 1
      if (attempt === 1) payload.messages = [payload.messages[retainedIndex]!]
      return next()
    })
    root.on('agent/request-error', async (payload: AgentRequestErrorEvent) =>
      payload.attempt === 1 ? { kind: 'retry' } : undefined)

    const service = dynamic(root).agent as AgentService
    await expect(service.run({ messages: [...await log.deriveMessages(), { role: 'user', content: 'go' }] }))
      .resolves.toMatchObject({ output: 'recovered' })
    expect(requests).toEqual([
      [{ role: 'user', content: retained }],
      [
        { role: 'user', content: 'earlier' },
        { role: 'assistant', content: 'earlier answer' },
        { role: 'user', content: 'go' },
      ],
    ])
    expect(await log.deriveMessages()).toEqual([
      { role: 'user', content: 'earlier' },
      { role: 'assistant', content: 'earlier answer' },
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'recovered' },
    ])
  })

  it('continues after an empty assistant response using the durable transcript', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('empty-assistant-continue.jsonl') })
    await root.plugin(tools)
    const { adapter, calls } = fakeLLM([
      { content: '', finishReason: 'stop' },
      { content: 'done', finishReason: 'stop' },
    ])
    await root.plugin(agent, { llm: adapter })
    let stopping = 0
    root.on('agent/turn-stopping', () => ++stopping === 1 ? 'continue' : undefined)

    const service = dynamic(root).agent as AgentService
    await expect(service.run({ text: 'go' })).resolves.toMatchObject({ output: 'done' })
    expect(calls[1]!.messages).toEqual([{ role: 'user', content: 'go' }])
  })

  it('rejects reordered assistant and tool messages already on the durable surface', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('reordered-tool-transcript.jsonl') })
    await root.plugin(tools)
    const log = dynamic(root).session as SessionLog
    await log.append('user/message', { content: 'sum' })
    await log.append('assistant/message', { content: '', toolCalls: [toolCall('c1', 'add', { a: 1, b: 2 })] })
    await log.append('tool/call', { id: 'c1', name: 'add', arguments: { a: 1, b: 2 } })
    await log.append('tool/result', { id: 'result-c1', toolCallId: 'c1', name: 'add', ok: true, output: 3 })
    const { adapter, calls } = fakeLLM([{ content: 'never', finishReason: 'stop' }])
    await root.plugin(agent, { llm: adapter })
    root.on('llm/stream', async (payload: LLMStreamRequestEvent, next) => {
      const [user, assistant, tool] = payload.messages
      payload.messages = [user!, tool!, assistant!]
      return next()
    })

    const service = dynamic(root).agent as AgentService
    await expect(service.run({ messages: await log.deriveMessages() })).rejects.toThrow('not reconstructable')
    expect(calls).toHaveLength(0)
    expect((await log.deriveMessages()).map(message => message.role)).toEqual(['user', 'assistant', 'tool'])
  })

  it('marks a run cancelled when the stream aborts', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('stream-cancel.jsonl') })
    await root.plugin(tools)
    const controller = new AbortController()
    const adapter: LLMAdapter = {
      complete: async () => {
        throw new Error('complete should not be used')
      },
      stream: async function* (_messages, _tools, options) {
        yield { type: 'message_start', id: 'm1' }
        yield { type: 'message_delta', id: 'm1', delta: 'partial' }
        setTimeout(() => controller.abort(), 0)
        await new Promise<void>((resolve, reject) => {
          const abort = (): void => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          }
          if (options.signal?.aborted) {
            abort()
            return
          }
          options.signal?.addEventListener('abort', abort, { once: true })
        })
      },
    }
    await root.plugin(agent, { llm: adapter })

    const service = dynamic(root).agent as AgentService
    const { events, result } = await collectStream(
      service.runStream({ text: 'go' }, { signal: controller.signal }),
    )

    expect(events.filter(event => event.type !== 'assistant/stream').map(event => event.type)).toEqual([
      'message_start',
      'message_delta',
      'run/end',
    ])
    expect(result.finishReason).toBe('cancelled')

    const log = dynamic(root).session as SessionLog
    const durableEvents = await log.read()
    expect(durableEvents.map(event => event.type)).toEqual([
      'meta',
      'turn/start',
      'step/start',
      'request/header',
      'request/context',
      'user/message',
      'assistant/chunk',
      'assistant/message',
      'step/end',
      'turn/end',
    ])
    expect(durableEvents[6]).toMatchObject({
      type: 'assistant/chunk',
      payload: { id: 'm1', content: 'partial', index: 0 },
    })
    expect(durableEvents[7]?.payload).toMatchObject({
      content: 'partial',
      interrupted: true,
    })
    expect(await log.deriveMessages()).toEqual([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'partial' },
    ])
  })

  it('settles completed tool calls when the stream aborts before dispatch', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('stream-tool-batch-cancel.jsonl') })
    await root.plugin(tools)
    const controller = new AbortController()
    const executions: string[] = []
    const toolService = dynamic(root).tools as ToolsService
    toolService.register({
      schema: { name: 'first', description: 'must not run' },
      execute: () => {
        executions.push('first')
        return 'unexpected'
      },
    })
    toolService.register({
      schema: { name: 'second', description: 'must not run' },
      execute: () => {
        executions.push('second')
        return 'unexpected'
      },
    })
    const adapter: LLMAdapter = {
      complete: async () => {
        throw new Error('complete should not be used')
      },
      stream: async function* () {
        yield { type: 'message_start', id: 'm1' }
        yield { type: 'toolcall_start', id: 'c1', index: 0, name: 'first' }
        yield { type: 'toolcall_end', id: 'c1', index: 0, name: 'first', arguments: {} }
        yield { type: 'toolcall_start', id: 'c2', index: 1, name: 'second' }
        yield { type: 'toolcall_end', id: 'c2', index: 1, name: 'second', arguments: {} }
        yield { type: 'message_stop', id: 'm1', finishReason: 'tool_calls' }
        controller.abort({ type: 'user' })
      },
    }
    await root.plugin(agent, { llm: adapter })

    const service = dynamic(root).agent as AgentService
    const result = await service.run({ text: 'go' }, { signal: controller.signal })

    expect(result.finishReason).toBe('cancelled')
    expect(executions).toEqual([])
    const log = dynamic(root).session as SessionLog
    const events = await log.read()
    expect(events.filter(event => event.type === 'assistant/message')).toMatchObject([
      {
        payload: {
          content: '',
          toolCalls: [
            { id: 'c1', name: 'first', arguments: {} },
            { id: 'c2', name: 'second', arguments: {} },
          ],
        },
      },
    ])
    expect(events.filter(event => event.type === 'tool/call' || event.type === 'tool/result')).toMatchObject([
      { type: 'tool/call', payload: { id: 'c1', name: 'first' } },
      {
        type: 'tool/result',
        payload: {
          toolCallId: 'c1',
          ok: false,
          error: { name: 'AbortError', message: 'tool call aborted: user' },
        },
      },
      { type: 'tool/call', payload: { id: 'c2', name: 'second' } },
      {
        type: 'tool/result',
        payload: {
          toolCallId: 'c2',
          ok: false,
          error: { name: 'AbortError', message: 'tool call aborted: user' },
        },
      },
    ])
  })

  it('waits for an in-flight tool before marking the run cancelled', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('tool-cancel.jsonl') })
    await root.plugin(tools)
    const toolService = dynamic(root).tools as ToolsService
    toolService.register({
      schema: { name: 'slow', description: 'slow tool' },
      execute: () => {
        setTimeout(() => controller.abort(), 0)
        return new Promise(resolve => setTimeout(() => resolve('done'), 30))
      },
    })
    const adapter: LLMAdapter = {
      complete: async () => ({
        content: '',
        toolCalls: [toolCall('c1', 'slow', {})],
        finishReason: 'tool_calls',
      }),
    }
    await root.plugin(agent, { llm: adapter })

    const controller = new AbortController()
    const service = dynamic(root).agent as AgentService
    const result = await service.run({ text: 'go' }, { signal: controller.signal })

    expect(result.finishReason).toBe('cancelled')
    const log = dynamic(root).session as SessionLog
    const events = await log.read()
    expect(events.map(event => event.type)).toEqual([
      'meta',
      'turn/start',
      'step/start',
      'request/header',
      'request/context',
      'user/message',
      'assistant/message',
      'tool/call',
      'tool/result',
      'step/end',
      'turn/end',
    ])
    expect(events[9]?.payload).toMatchObject({
      finishReason: 'cancelled',
      interrupted: true,
      cancelCause: { type: 'abort' },
    })
    expect(events[10]?.payload).toMatchObject({
      finishReason: 'cancelled',
      cancelCause: { type: 'abort' },
    })
  })

  it('records aborted results for tool calls not started after cancellation', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('tool-batch-cancel.jsonl') })
    await root.plugin(tools)
    const controller = new AbortController()
    let secondExecutions = 0
    const toolService = dynamic(root).tools as ToolsService
    toolService.register({
      schema: { name: 'cancel', description: 'cancel the batch' },
      execute: () => {
        controller.abort({ type: 'user' })
        return 'cancelled first'
      },
    })
    toolService.register({
      schema: { name: 'second', description: 'must not run' },
      execute: () => {
        secondExecutions += 1
        return 'unexpected'
      },
    })
    const adapter: LLMAdapter = {
      complete: async () => ({
        content: '',
        toolCalls: [
          toolCall('c1', 'cancel', {}),
          toolCall('c2', 'second', {}),
        ],
        finishReason: 'tool_calls',
      }),
    }
    await root.plugin(agent, { llm: adapter })

    const service = dynamic(root).agent as AgentService
    const result = await service.run({ text: 'go' }, { signal: controller.signal })

    expect(result.finishReason).toBe('cancelled')
    expect(secondExecutions).toBe(0)
    const log = dynamic(root).session as SessionLog
    const events = await log.read()
    const toolEvents = events.filter(event => event.type === 'tool/call' || event.type === 'tool/result')
    expect(toolEvents).toMatchObject([
      { type: 'tool/call', payload: { id: 'c1', name: 'cancel' } },
      { type: 'tool/result', payload: { toolCallId: 'c1', ok: true } },
      { type: 'tool/call', payload: { id: 'c2', name: 'second' } },
      {
        type: 'tool/result',
        payload: {
          id: 'c2',
          toolCallId: 'c2',
          name: 'second',
          ok: false,
          error: { name: 'AbortError', message: 'tool call aborted: user' },
        },
      },
    ])
  })

  it('preserves a typed user cancellation cause in durable events', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('tool-cancel-user.jsonl') })
    await root.plugin(tools)
    const toolService = dynamic(root).tools as ToolsService
    toolService.register({
      schema: { name: 'slow', description: 'slow tool' },
      execute: () => {
        setTimeout(() => controller.abort({ type: 'user' }), 0)
        return new Promise(resolve => setTimeout(() => resolve('done'), 30))
      },
    })
    const adapter: LLMAdapter = {
      complete: async () => ({
        content: '',
        toolCalls: [toolCall('c1', 'slow', {})],
        finishReason: 'tool_calls',
      }),
    }
    await root.plugin(agent, { llm: adapter })

    const controller = new AbortController()
    const service = dynamic(root).agent as AgentService
    const result = await service.run({ text: 'go' }, { signal: controller.signal })

    expect(result.finishReason).toBe('cancelled')
    const log = dynamic(root).session as SessionLog
    const events = await log.read()
    const stepEnd = events.find(event => event.type === 'step/end')
    const turnEnd = events.find(event => event.type === 'turn/end')
    expect(stepEnd?.payload).toMatchObject({
      finishReason: 'cancelled',
      interrupted: true,
      cancelCause: { type: 'user' },
    })
    expect(turnEnd?.payload).toMatchObject({
      finishReason: 'cancelled',
      cancelCause: { type: 'user' },
    })
  })

  it('writes durable turn and step lifecycle around model calls', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('durable-lifecycle.jsonl') })
    await root.plugin(tools)
    const { adapter } = fakeLLM([{ content: 'hello', finishReason: 'stop' }])
    await root.plugin(agent, { llm: adapter })

    const loop = root.get('agentLoop') as AgentLoop
    await loop({ text: 'hi' })

    const log = dynamic(root).session as SessionLog
    const events = await log.read()
    expect(events.map(event => event.type)).toEqual([
      'meta',
      'turn/start',
      'step/start',
      'request/header',
      'request/context',
      'user/message',
      'assistant/message',
      'step/end',
      'turn/end',
    ])
    expect(events[1]?.payload).toMatchObject({ reason: 'user' })
    expect(events[2]?.payload).toEqual({ turn: 1, step: 0 })
    expect(events[7]?.payload).toMatchObject({
      turn: 1,
      step: 0,
      finishReason: 'stop',
      toolCalls: 0,
    })
    expect(events[8]?.payload).toMatchObject({ finishReason: 'stop', steps: 1 })
  })

  it('persists a new user turn without duplicating history', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('multi-turn.jsonl') })
    await root.plugin(tools)
    const { adapter, calls } = fakeLLM([
      { content: 'first answer', finishReason: 'stop' },
      { content: 'second answer', finishReason: 'stop' },
    ])
    await root.plugin(agent, { llm: adapter })

    const loop = root.get('agentLoop') as AgentLoop
    await loop({ text: 'first' })
    const log = dynamic(root).session as SessionLog
    const history = await log.deriveMessages()
    const secondInput: ModelMessage[] = [
      ...history,
      { role: 'user', content: 'second' },
    ]
    const second = await loop({ messages: secondInput })

    expect(calls).toHaveLength(2)
    expect(calls[1]!.messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second' },
    ])
    expect(second.output).toBe('second answer')

    expect(await log.deriveMessages()).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'second answer' },
    ])
    const userMessages = (await log.read()).filter(
      (event): event is Extract<SessionEvent, { type: 'user/message' }> =>
        event.type === 'user/message',
    )
    expect(userMessages.map(event => event.payload.content)).toEqual(['first', 'second'])
  })

  it('does not duplicate history when the new user text repeats an old one', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('multi-turn-repeat.jsonl') })
    await root.plugin(tools)
    const { adapter } = fakeLLM([
      { content: 'answer a', finishReason: 'stop' },
      { content: 'answer b', finishReason: 'stop' },
      { content: 'answer c', finishReason: 'stop' },
    ])
    await root.plugin(agent, { llm: adapter })

    const loop = root.get('agentLoop') as AgentLoop
    await loop({ text: 'first' })
    const log = dynamic(root).session as SessionLog
    const history = await log.deriveMessages()
    await loop({ messages: [...history, { role: 'user', content: 'first' }] })
    const history2 = await log.deriveMessages()
    await loop({ messages: [...history2, { role: 'user', content: 'first' }] })

    const userMessages = (await log.read()).filter(
      (event): event is Extract<SessionEvent, { type: 'user/message' }> =>
        event.type === 'user/message',
    )
    expect(userMessages.map(event => event.payload.content)).toEqual([
      'first',
      'first',
      'first',
    ])
  })

  it('does not re-append old user turns when a resumed run prepends a run-scoped system prompt', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('resume-system-skew.jsonl') })
    await root.plugin(tools)
    const { adapter } = fakeLLM([
      { content: 'first answer', finishReason: 'stop' },
      { content: 'second answer', finishReason: 'stop' },
    ])
    await root.plugin(agent, { llm: adapter })

    const systemPrompt = 'You are a coding agent'
    const loop = root.get('agentLoop') as AgentLoop
    // First run mirrors the web server shape: a run-scoped system prompt is
    // part of the model input and becomes durable on a fresh log.
    await loop({
      text: 'first',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'first' },
      ],
    })
    const log = dynamic(root).session as SessionLog
    const history = await log.deriveMessages()
    // Resumed run also mirrors the server: the caller prepends the same
    // run-scoped system prompt (not part of the durable surface) ahead of the
    // full derived history, then appends the new user turn.
    await loop({
      text: 'second',
      messages: [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: 'second' },
      ],
    })

    const userMessages = (await log.read()).filter(
      (event): event is Extract<SessionEvent, { type: 'user/message' }> =>
        event.type === 'user/message',
    )
    expect(userMessages.map(event => event.payload.content)).toEqual([
      'first',
      'second',
    ])
    const surface = await log.deriveMessages()
    expect(surface.filter(message => message.role === 'user').map(message => message.content)).toEqual([
      'first',
      'second',
    ])
  })

  it('persists only the delta when pre-step rewrites multi-user history', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('pre-step-delta.jsonl') })
    await root.plugin(tools)
    const { adapter, calls } = fakeLLM([
      { content: 'first answer', finishReason: 'stop' },
      { content: 'second answer', finishReason: 'stop' },
    ])
    await root.plugin(agent, { llm: adapter })

    root.on('agent/pre-step', (payload: AgentPreStepEvent, next) => {
      const first = payload.messages[0]
      if (!(first?.role === 'user' && first.content === 'context')) {
        payload.messages = [
          { role: 'user', content: 'context' },
          ...payload.messages,
        ]
      }
      return next()
    })

    const loop = root.get('agentLoop') as AgentLoop
    await loop({ text: 'first' })
    const log = dynamic(root).session as SessionLog
    const history = await log.deriveMessages()
    const secondInput: ModelMessage[] = [
      ...history,
      { role: 'user', content: 'second' },
    ]
    await loop({ messages: secondInput })

    expect(calls[0]!.messages).toEqual([
      { role: 'user', content: 'context' },
      { role: 'user', content: 'first' },
    ])
    expect(calls[1]!.messages).toEqual([
      { role: 'user', content: 'context' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second' },
    ])

    expect(await log.deriveMessages()).toEqual([
      { role: 'user', content: 'context' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'second answer' },
    ])
  })

  it('lets agent/pre-step rewrite the model input and persists it', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('pre-step.jsonl') })
    await root.plugin(tools)
    const { adapter, calls } = fakeLLM([{ content: 'ok', finishReason: 'stop' }])
    await root.plugin(agent, { llm: adapter })

    const seen: number[] = []
    root.on('agent/pre-step', (payload: AgentPreStepEvent, next) => {
      seen.push(payload.index)
      payload.messages = [
        ...payload.messages.filter(message => message.role !== 'user'),
        { role: 'user', content: 'steered' },
      ]
      return next()
    })

    const loop = root.get('agentLoop') as AgentLoop
    await loop({ text: 'original' })
    expect(seen).toEqual([0])
    expect(calls[0]!.messages).toEqual([{ role: 'user', content: 'steered' }])

    const log = dynamic(root).session as SessionLog
    expect(await log.deriveMessages()).toEqual([
      { role: 'user', content: 'steered' },
      { role: 'assistant', content: 'ok' },
    ])
  })

  it('lets agent/pre-step reject a proposed step without calling the model', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('pre-step-reject.jsonl') })
    await root.plugin(tools)
    const { adapter, calls } = fakeLLM([{ content: 'unused', finishReason: 'stop' }])
    await root.plugin(agent, { llm: adapter })
    root.on('agent/pre-step', (payload: AgentPreStepEvent, next) => {
      payload.admission = 'reject'
      return next()
    })

    const loop = root.get('agentLoop') as AgentLoop
    const result = await loop({ text: 'blocked' })

    expect(calls).toHaveLength(0)
    expect(result.steps).toHaveLength(0)
  })

  it('awaits agent/pre-step rewrites before admitting and persisting the step input', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('async-pre-step.jsonl') })
    await root.plugin(tools)
    const { adapter, calls } = fakeLLM([{ content: 'ok', finishReason: 'stop' }])
    await root.plugin(agent, { llm: adapter })

    root.on('agent/pre-step', async (payload: AgentPreStepEvent, next) => {
      await Promise.resolve()
      payload.messages = [
        { role: 'system', content: 'async system' },
        { role: 'user', content: 'async admitted' },
      ]
      return next()
    })

    const loop = root.get('agentLoop') as AgentLoop
    await loop({ text: 'original' })

    expect(calls[0]!.messages).toEqual([
      { role: 'system', content: 'async system' },
      { role: 'user', content: 'async admitted' },
    ])
    const log = dynamic(root).session as SessionLog
    expect(log.requestHeader()).toEqual({ reason: 'initial', system: 'async system' })
    expect(await log.deriveMessages()).toEqual([
      { role: 'system', content: 'async system' },
      { role: 'user', content: 'async admitted' },
      { role: 'assistant', content: 'ok' },
    ])
  })

  it('starts a request series from pre-step', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('pre-step-series.jsonl') })
    await root.plugin(tools)
    const { adapter } = fakeLLM([
      { content: 'first', finishReason: 'stop' },
      { content: 'second', finishReason: 'stop' },
    ])
    await root.plugin(agent, { llm: adapter })

    let secondTurn = false
    root.on('agent/pre-step', (payload: AgentPreStepEvent, next) => {
      if (secondTurn) payload.startsRequestSeries = true
      secondTurn = true
      return next()
    })
    const loop = root.get('agentLoop') as AgentLoop
    await loop({ text: 'first' })
    await loop({ text: 'second' })

    const log = dynamic(root).session as SessionLog
    const headers = (await log.read())
      .filter(event => event.type === 'request/header')
    expect(headers.map(event => (event.payload as { reason: string }).reason)).toEqual([
      'initial',
      'series',
    ])
    expect((headers.at(-1)?.payload as { startsSeries?: boolean }).startsSeries).toBe(true)
    expect(await log.deriveMessages()).toEqual([
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'second' },
    ])
  })

  it('keeps agent/request messages read-only while pre-step owns the rewrite', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('request-wrap.jsonl') })
    await root.plugin(tools)
    const { adapter, calls } = fakeLLM([{ content: 'ok', finishReason: 'stop' }])
    await root.plugin(agent, { llm: adapter })

    root.on('agent/pre-step', (payload: AgentPreStepEvent, next) => {
      payload.messages = [
        { role: 'user', content: 'wrapped' },
      ]
      return next()
    })
    root.on('agent/request', (payload: AgentRequestEvent, next) => {
      payload.options = { ...payload.options, maxSteps: 1 }
      return next()
    })

    const loop = root.get('agentLoop') as AgentLoop
    await loop({ text: 'original' })
    expect(calls[0]!.messages).toEqual([{ role: 'user', content: 'wrapped' }])

    const log = dynamic(root).session as SessionLog
    expect(await log.deriveMessages()).toEqual([
      { role: 'user', content: 'wrapped' },
      { role: 'assistant', content: 'ok' },
    ])
  })

  it('awaits agent/request route, tool and option rewrites before dispatch and persistence', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('async-request.jsonl') })
    await root.plugin(tools)
    const registered = addTool()
    ;(dynamic(root).tools as ToolsService).register(registered)
    const received: Array<{
      messages: readonly ModelMessage[]
      tools: readonly ToolDefinition[]
      options: { provider?: string; model?: string; temperature?: number }
    }> = []
    const adapter: LLMAdapter = {
      async complete(messages, availableTools, options) {
        received.push({ messages, tools: availableTools, options })
        return { content: 'ok', finishReason: 'stop' }
      },
    }
    await root.plugin(agent, { llm: adapter })

    root.on('agent/request', async (payload: AgentRequestEvent, next) => {
      await Promise.resolve()
      payload.tools = [registered]
      payload.options = {
        ...payload.options,
        provider: 'async-provider',
        model: 'async-model',
        temperature: 0.75,
      }
      return next()
    })

    const loop = root.get('agentLoop') as AgentLoop
    await loop({ text: 'original' })

    expect(received).toEqual([{
      messages: [{ role: 'user', content: 'original' }],
      tools: [registered],
      options: {
        maxSteps: 64,
        provider: 'async-provider',
        model: 'async-model',
        temperature: 0.75,
      },
    }])
    const log = dynamic(root).session as SessionLog
    expect(log.requestHeader()).toEqual({
      reason: 'initial',
      tools: [{ name: 'add', description: 'add two numbers' }],
      config: { provider: 'async-provider', model: 'async-model', temperature: 0.75 },
    })
    expect(log.requestContext()).toEqual({ provider: 'async-provider', model: 'async-model' })
  })

  it('lets agent/turn-stopping keep the turn alive', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('turn-stopping.jsonl') })
    await root.plugin(tools)
    const { adapter, calls } = fakeLLM([
      { content: 'one', finishReason: 'stop' },
      { content: 'two', finishReason: 'stop' },
    ])
    await root.plugin(agent, { llm: adapter })

    let stopping = 0
    root.on('agent/turn-stopping', () => {
      stopping += 1
      return stopping === 1 ? 'continue' : undefined
    })

    const loop = root.get('agentLoop') as AgentLoop
    const result = await loop({ text: 'go' })
    expect(stopping).toBe(2)
    expect(result.steps).toHaveLength(2)
    expect(result.output).toBe('two')
    expect(calls).toHaveLength(2)
  })

  it('recovers a failed model request through agent/request-error', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('request-error-retry.jsonl') })
    await root.plugin(tools)
    let calls = 0
    const adapter: LLMAdapter = {
      complete: async () => {
        calls += 1
        if (calls === 1) throw new Error('transient model failure')
        return { content: 'recovered', finishReason: 'stop' }
      },
    }
    await root.plugin(agent, { llm: adapter })

    const seen: Array<{ index: number; attempt: number }> = []
    root.on('agent/request-error', async (payload: AgentRequestErrorEvent) => {
      await Promise.resolve()
      seen.push({ index: payload.index, attempt: payload.attempt })
      expect(payload.turn).toBe(1)
      expect(payload.step).toBe(0)
      expect(payload.failure).toMatchObject({
        name: 'Error',
        message: 'transient model failure',
      })
      return { kind: 'retry' }
    })

    const loop = root.get('agentLoop') as AgentLoop
    const result = await loop({ text: 'go' })

    expect(result.output).toBe('recovered')
    expect(result.finishReason).toBe('stop')
    expect(result.steps).toHaveLength(1)
    expect(calls).toBe(2)
    expect(seen).toEqual([{ index: 0, attempt: 1 }])

    const log = dynamic(root).session as SessionLog
    const events = await log.read()
    expect(events.map(event => event.type)).toEqual([
      'meta',
      'turn/start',
      'step/start',
      'request/header',
      'request/context',
      'user/message',
      'assistant/attempt',
      'llm/retry',
      'llm/retry-started',
      'assistant/message',
      'step/end',
      'turn/end',
    ])
    const retry = events.find(
      (event): event is Extract<SessionEvent, { type: 'llm/retry' }> =>
        event.type === 'llm/retry',
    )
    const retryStarted = events.find(
      (event): event is Extract<SessionEvent, { type: 'llm/retry-started' }> =>
        event.type === 'llm/retry-started',
    )
    expect(retry?.payload).toMatchObject({
      retry: 1,
      failure: { name: 'Error', message: 'transient model failure' },
    })
    expect(typeof retry?.payload.retryId).toBe('string')
    expect(retryStarted?.payload).toMatchObject({ retry: 1 })
    expect(retryStarted?.payload.retryId).toBe(retry?.payload.retryId)
    expect(events.filter(event => event.type === 'user/message')).toHaveLength(1)
    expect(events.filter(event => event.type === 'step/start')).toHaveLength(1)
    expect(events.filter(event => event.type === 'step/end')).toHaveLength(1)
    expect(await log.deriveMessages()).toEqual([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'recovered' },
    ])
  })

  it('enforces replayability when assertReplayable is enabled', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('assert-replay.jsonl') })
    await root.plugin(tools)
    const service = dynamic(root).tools as ToolsService
    service.register(addTool())
    const { adapter } = fakeLLM([
      {
        content: '',
        toolCalls: [toolCall('c1', 'add', { a: 1, b: 2 })],
        finishReason: 'tool_calls',
      },
      { content: 'done', finishReason: 'stop' },
    ])
    await root.plugin(agent, { llm: adapter, assertReplayable: true })

    const loop = root.get('agentLoop') as AgentLoop
    const result = await loop({ text: 'sum' })
    expect(result.output).toBe('done')
    expect(result.steps).toHaveLength(2)
  })

  it('stops the turn when a tool result concludes the turn', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('concludes-turn.jsonl') })
    await root.plugin(tools)
    const service = dynamic(root).tools as ToolsService
    service.register({
      ...addTool(),
      metadata: { concludesTurn: true },
    })
    let calls = 0
    const adapter: LLMAdapter = {
      async complete() {
        calls += 1
        return {
          content: '',
          toolCalls: [toolCall('c1', 'add', { a: 1, b: 2 })],
          finishReason: 'tool_calls',
        }
      },
    }
    await root.plugin(agent, { llm: adapter })

    const loop = root.get('agentLoop') as AgentLoop
    const result = await loop({ text: 'sum' })
    expect(calls).toBe(1)
    expect(result.steps).toHaveLength(1)
    expect(result.finishReason).toBe('stop')
  })

  it('excludes a failed non-cancelled stream prefix from retry history', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('request-error-stream.jsonl') })
    await root.plugin(tools)
    const requests: ModelMessage[][] = []
    let calls = 0
    const adapter: LLMAdapter = {
      complete: async () => {
        throw new Error('complete should not be used')
      },
      stream: async function* (messages) {
        calls += 1
        requests.push([...messages])
        if (calls === 1) {
          yield { type: 'message_start', id: 'm1' }
          yield { type: 'message_delta', id: 'm1', delta: 'recover' }
          throw new Error('stream interrupted')
        }
        yield { type: 'message_start', id: 'm2' }
        yield { type: 'message_delta', id: 'm2', delta: 'ed' }
        yield { type: 'message_stop', id: 'm2', finishReason: 'stop' }
      },
    }
    await root.plugin(agent, { llm: adapter })

    root.on('agent/request-error', async () => ({ kind: 'retry' }))
    const service = dynamic(root).agent as AgentService
    const { result } = await collectStream(service.runStream({ text: 'go' }))

    expect(result.output).toBe('ed')
    expect(result.steps[0]!.input).toEqual([
      { role: 'user', content: 'go' },
    ])
    expect(result.steps[0]!.completion.content).toBe('ed')
    expect(calls).toBe(2)
    expect(requests[0]).toEqual([{ role: 'user', content: 'go' }])
    expect(requests[1]).toEqual([
      { role: 'user', content: 'go' },
    ])

    const log = dynamic(root).session as SessionLog
    const events = await log.read()
    expect(events.map(event => event.type)).toEqual([
      'meta',
      'turn/start',
      'step/start',
      'request/header',
      'request/context',
      'user/message',
      'assistant/chunk',
      'assistant/attempt',
      'llm/retry',
      'llm/retry-started',
      'assistant/chunk',
      'assistant/message',
      'step/end',
      'turn/end',
    ])
    expect(events[6]).toMatchObject({
      type: 'assistant/chunk',
      payload: { id: 'm1', content: 'recover', index: 0 },
    })
    expect(events.filter(event => event.type === 'assistant/message'))
      .toMatchObject([{ payload: { content: 'ed' } }])
    expect(await log.deriveMessages()).toEqual([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'ed' },
    ])
  })

  it('closes step and turn with an error when the model request fails', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('lifecycle-error.jsonl') })
    await root.plugin(tools)
    const adapter: LLMAdapter = {
      complete: async () => {
        throw new Error('model exploded')
      },
    }
    await root.plugin(agent, { llm: adapter })

    const loop = root.get('agentLoop') as AgentLoop
    await expect(loop({ text: 'go' })).rejects.toThrow('model exploded')

    const log = dynamic(root).session as SessionLog
    const events = await log.read()
    expect(events.map(event => event.type)).toEqual([
      'meta',
      'turn/start',
      'step/start',
      'request/header',
      'request/context',
      'user/message',
      'assistant/attempt',
      'step/end',
      'turn/end',
    ])
    expect(events.find(event => event.type === 'step/end')?.payload).toMatchObject({
      turn: 1,
      step: 0,
      finishReason: 'error',
      interrupted: true,
      error: { name: 'Error', message: 'model exploded' },
    })
    expect(events.find(event => event.type === 'turn/end')?.payload).toMatchObject({
      finishReason: 'error',
      interrupted: true,
      error: { name: 'Error', message: 'model exploded' },
    })
  })
})

describe('request header snapshots across steps', () => {
  it('does not append a header when the envelope is unchanged', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('header-stable.jsonl') })
    await root.plugin(tools)
    const service = dynamic(root).tools as ToolsService
    service.register(addTool())
    const { adapter } = fakeLLM([
      {
        content: '',
        toolCalls: [toolCall('c1', 'add', { a: 1, b: 2 })],
        finishReason: 'tool_calls',
      },
      { content: 'done', finishReason: 'stop' },
    ])
    await root.plugin(agent, { llm: adapter })

    const loop = root.get('agentLoop') as AgentLoop
    await loop({ text: 'sum' })

    const log = dynamic(root).session as SessionLog
    const events = await log.read()
    const headers = events.filter(event => event.type === 'request/header')
    expect(headers).toHaveLength(1)
    expect((headers[0]?.payload as { reason: string }).reason).toBe('initial')
  })

  it('records explicit series boundaries as series headers', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('header-series.jsonl') })
    await root.plugin(tools)
    const { adapter } = fakeLLM([
      { content: 'one', finishReason: 'stop' },
      { content: 'two', finishReason: 'stop' },
    ])
    await root.plugin(agent, { llm: adapter })
    const service = dynamic(root).agent as AgentService

    const loop = root.get('agentLoop') as AgentLoop
    await loop({ text: 'first' })
    service.startSeries()
    await loop({ text: 'second' })

    const log = dynamic(root).session as SessionLog
    const headers = (await log.read())
      .filter(event => event.type === 'request/header')
    expect(headers.map(event => (event.payload as { reason: string }).reason)).toEqual([
      'initial',
      'series',
    ])
    expect((headers[1]?.payload as { startsSeries?: boolean }).startsSeries).toBe(true)
  })

  it('records a changed envelope at a series boundary as change-series', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('header-change-series.jsonl') })
    await root.plugin(tools)
    const service = dynamic(root).tools as ToolsService
    service.register(addTool())
    const { adapter } = fakeLLM([
      { content: 'one', finishReason: 'stop' },
      {
        content: '',
        toolCalls: [toolCall('c1', 'add', { a: 1, b: 2 })],
        finishReason: 'tool_calls',
      },
    ])
    await root.plugin(agent, { llm: adapter })
    const agentService = dynamic(root).agent as AgentService

    const loop = root.get('agentLoop') as AgentLoop
    await loop({ text: 'first' })
    agentService.startSeries()
    await loop({ text: 'second' })

    const log = dynamic(root).session as SessionLog
    const headers = (await log.read())
      .filter(event => event.type === 'request/header')
    const reasons = headers.map(event => (event.payload as { reason: string }).reason)
    expect(reasons[0]).toBe('initial')
    expect(reasons.at(-1)).toBe('series')
    expect((headers.at(-1)?.payload as { startsSeries?: boolean }).startsSeries).toBe(true)
  })

  it('records contextWindow on request context when route capacity is available', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('request-context-capacity.jsonl') })
    await root.plugin(tools)
    await root.plugin(llmService)
    const service = dynamic(root).llm as LlmService
    const adapter = fakeLLM([{ content: 'ok', finishReason: 'stop' }]).adapter
    ;(adapter as unknown as { model?: string }).model = 'deepseek-v4-flash'
    service.register('catalog', adapter)
    service.setCapacityResolver(model => model === 'deepseek-v4-flash' ? 1_000_000 : undefined)
    await root.plugin(agent)

    const loop = root.get('agentLoop') as AgentLoop
    await loop({ text: 'hi' })

    const log = dynamic(root).session as SessionLog
    const contexts = (await log.read()).filter(event => event.type === 'request/context')
    expect(contexts.at(-1)?.payload).toMatchObject({
      contextWindow: 1_000_000,
    })
  })

  it('records a new request context when route capacity changes', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('request-context-capacity-change.jsonl') })
    await root.plugin(tools)
    await root.plugin(llmService)
    const service = dynamic(root).llm as LlmService
    let capacity = 100_000
    const adapter = fakeLLM([
      { content: 'ok', finishReason: 'stop' },
      { content: 'ok2', finishReason: 'stop' },
    ]).adapter
    ;(adapter as unknown as { model?: string }).model = 'catalog-model'
    service.register('catalog', adapter)
    service.setCapacityResolver(() => capacity)
    await root.plugin(agent)

    const loop = root.get('agentLoop') as AgentLoop
    await loop({ text: 'first' })
    capacity = 1_000_000
    await loop({ text: 'second' })

    const log = dynamic(root).session as SessionLog
    const contexts = (await log.read()).filter(event => event.type === 'request/context')
    expect(contexts.map(event => (event.payload as { contextWindow?: number }).contextWindow))
      .toEqual([100_000, 1_000_000])
  })

  it('clears route capacity in request context when it disappears', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('request-context-capacity-clear.jsonl') })
    await root.plugin(tools)
    await root.plugin(llmService)
    const service = dynamic(root).llm as LlmService
    let capacity: number | undefined = 100_000
    const adapter = fakeLLM([
      { content: 'ok', finishReason: 'stop' },
      { content: 'ok2', finishReason: 'stop' },
    ]).adapter
    ;(adapter as unknown as { model?: string }).model = 'catalog-model'
    service.register('catalog', adapter)
    service.setCapacityResolver(() => capacity)
    await root.plugin(agent)

    const loop = root.get('agentLoop') as AgentLoop
    await loop({ text: 'first' })
    capacity = undefined
    await loop({ text: 'second' })

    const log = dynamic(root).session as SessionLog
    const contexts = (await log.read()).filter(event => event.type === 'request/context')
    const windows = contexts.map(event =>
      (event.payload as { contextWindow?: number }).contextWindow)
    expect(windows).toEqual([100_000, undefined])
  })
})
