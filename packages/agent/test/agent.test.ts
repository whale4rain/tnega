import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { Context, FiberState } from '@tnega/core'
import { SessionLog, session, type ModelMessage, type SessionEvent } from '@tnega/session'
import { tools, ToolsService, type ToolDefinition } from '@tnega/tools'

import {
  agent,
  AgentError,
  AgentInbox,
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
    root.on('agent/start', () => events.push('start'))
    root.on('agent/turn-start', () => events.push('turn-start'))
    root.on('agent/step', () => events.push('step'))
    root.on('agent/tool-call', (payload: AgentToolCallEvent) => {
      events.push(`tool-call:${payload.call.id}`)
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

    expect(events.map(event => event.type)).toEqual([
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

    expect(events.map(event => event.type)).toEqual([
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
    setTimeout(() => controller.abort(), 5)
    const { events, result } = await collectStream(
      service.runStream({ text: 'go' }, { signal: controller.signal }),
    )

    expect(events.map(event => event.type)).toEqual(['message_start', 'run/end'])
    expect(result.finishReason).toBe('cancelled')
  })

  it('waits for an in-flight tool before marking the run cancelled', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('tool-cancel.jsonl') })
    await root.plugin(tools)
    const toolService = dynamic(root).tools as ToolsService
    toolService.register({
      schema: { name: 'slow', description: 'slow tool' },
      execute: () => new Promise(resolve => setTimeout(() => resolve('done'), 30)),
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
    setTimeout(() => controller.abort(), 5)
    const service = dynamic(root).agent as AgentService
    const result = await service.run({ text: 'go' }, { signal: controller.signal })

    expect(result.finishReason).toBe('cancelled')
    const log = dynamic(root).session as SessionLog
    const events = await log.read()
    expect(events.map(event => event.type)).toEqual([
      'meta',
      'turn/start',
      'step/start',
      'user/message',
      'assistant/message',
      'tool/call',
      'tool/result',
      'step/end',
      'turn/end',
    ])
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
      'user/message',
      'assistant/message',
      'step/end',
      'turn/end',
    ])
    expect(events[1]?.payload).toMatchObject({ reason: 'user' })
    expect(events[2]?.payload).toEqual({ index: 0 })
    expect(events[5]?.payload).toMatchObject({
      index: 0,
      finishReason: 'stop',
      toolCalls: 0,
    })
    expect(events[6]?.payload).toMatchObject({ finishReason: 'stop', steps: 1 })
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

  it('lets agent/request wrap the final request payload', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('request-wrap.jsonl') })
    await root.plugin(tools)
    const { adapter, calls } = fakeLLM([{ content: 'ok', finishReason: 'stop' }])
    await root.plugin(agent, { llm: adapter })

    root.on('agent/request', (payload: AgentRequestEvent, next) => {
      payload.messages = [
        ...payload.messages.filter(message => message.role !== 'user'),
        { role: 'user', content: 'wrapped' },
      ]
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
      'user/message',
      'llm/retry',
      'llm/retry-started',
      'assistant/message',
      'step/end',
      'turn/end',
    ])
    expect(events[4]?.payload).toMatchObject({
      attempt: 1,
      error: { name: 'Error', message: 'transient model failure' },
    })
    expect(events[5]?.payload).toEqual({ attempt: 1 })
    expect(events.filter(event => event.type === 'user/message')).toHaveLength(1)
    expect(events.filter(event => event.type === 'step/start')).toHaveLength(1)
    expect(events.filter(event => event.type === 'step/end')).toHaveLength(1)
    expect(await log.deriveMessages()).toEqual([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'recovered' },
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
      'user/message',
      'llm/retry',
      'step/end',
      'turn/end',
    ])
    expect(events[4]?.payload).toMatchObject({
      attempt: 1,
      error: { name: 'Error', message: 'model exploded' },
    })
    expect(events[5]?.payload).toMatchObject({
      index: 0,
      finishReason: 'error',
      interrupted: true,
      error: { name: 'Error', message: 'model exploded' },
    })
    expect(events[6]?.payload).toMatchObject({
      finishReason: 'error',
      interrupted: true,
      error: { name: 'Error', message: 'model exploded' },
    })
  })
})
