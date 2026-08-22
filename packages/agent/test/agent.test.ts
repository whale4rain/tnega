import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { Context, FiberState } from '@tnega/core'
import { SessionLog, session, type ModelMessage } from '@tnega/session'
import { tools, ToolsService, type ToolDefinition } from '@tnega/tools'

import {
  agent,
  AgentError,
  AgentInbox,
  type AgentLoop,
  type AgentRunResult,
  type AgentToolCallEvent,
  type AgentToolResultEvent,
  type LLMAdapter,
  type LLMCompletion,
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
      { role: 'tool', content: 'error: boom', tool_call_id: 'c1', name: 'fail' },
    ])
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
    expect(result.finishReason).toBe('error')
  })
})
