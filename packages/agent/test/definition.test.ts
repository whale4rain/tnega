import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { Context, FiberState } from '@tnega/core'
import { SessionLog, session } from '@tnega/session'
import { tools, ToolsService, type ToolDefinition } from '@tnega/tools'

import {
  defineAgent,
  type AgentInput,
  type AgentLoop,
  type AgentRunOptions,
  type AgentRunResult,
  type LLMAdapter,
  type LLMCompletion,
} from '../src/index.js'

type DynamicContext = Context & {
  [key: string]: unknown
}

const dynamic = (ctx: Context): DynamicContext => ctx as unknown as DynamicContext

const dirs: string[] = []

async function tempFile(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-agent-def-'))
  dirs.push(dir)
  return join(dir, name)
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function fakeLLM(completion: LLMCompletion): {
  adapter: LLMAdapter
  messages: Array<readonly import('@tnega/session').ModelMessage[]>
} {
  const messages: Array<readonly import('@tnega/session').ModelMessage[]> = []
  return {
    adapter: {
      async complete(input) {
        messages.push(input)
        return completion
      },
    },
    messages,
  }
}

function customTool(): ToolDefinition {
  return {
    schema: { name: 'def_ping', description: 'returns pong' },
    execute: () => 'pong',
  }
}

async function mountRoot(): Promise<Context> {
  const root = new Context()
  await root.plugin(session, { file: await tempFile('definition.jsonl') })
  await root.plugin(tools)
  return root
}

describe('defineAgent contract', () => {
  it('requires a non-empty name', () => {
    expect(() => defineAgent({ name: '  ' })).toThrow(TypeError)
  })

  it('mounts a definition with the default agent loop and injects system', async () => {
    const root = await mountRoot()
    const { adapter, messages } = fakeLLM({ content: 'ok', finishReason: 'stop' })
    await root.plugin(defineAgent({
      name: 'default',
      system: 'You are a focused coding assistant.',
    }), { llm: adapter })

    const loop = root.get('agentLoop') as AgentLoop
    const result = await loop({ text: 'hello' })
    expect(result.output).toBe('ok')
    expect(messages[0]![0]).toEqual({
      role: 'system',
      content: 'You are a focused coding assistant.',
    })
    expect(messages[0]![1]).toEqual({ role: 'user', content: 'hello' })
  })

  it('resolves a function system prompt from the context', async () => {
    const root = await mountRoot()
    await root.plugin(defineAgent({
      name: 'fn-system',
      system: (ctx) => `agent on ${ctx.fiber.name}`,
      loop: async (input) => ({
        input: input ?? {},
        output: String((input?.messages ?? []).at(0)?.content),
        finishReason: 'stop',
        steps: [],
        messages: [...(input?.messages ?? [])],
      }),
    }))

    const loop = root.get('agentLoop') as AgentLoop
    const result = await loop({ text: 'go' })
    expect(result.messages[0]).toMatchObject({ role: 'system' })
    expect(String(result.messages[0]?.content)).toContain('agent on')
  })

  it('registers definition tools and removes them on unmount', async () => {
    const root = await mountRoot()
    const fiber = root.plugin(defineAgent({
      name: 'tooled',
      loop: async (input) => ({
        input: input ?? {},
        output: 'ok',
        finishReason: 'stop',
        steps: [],
        messages: [],
      }),
      tools: [customTool()],
    }))
    await fiber

    const service = dynamic(root).tools as ToolsService
    expect(service.has('def_ping')).toBe(true)
    const result = await service.execute('def_ping', {})
    expect(result.output).toBe('pong')

    await fiber.dispose()
    expect(service.has('def_ping')).toBe(false)
    expect(root.get('agentLoop')).toBeUndefined()
  })

  it('prepends system to a custom loop input and runs hooks', async () => {
    const root = await mountRoot()
    const events: string[] = []
    const seen: AgentInput[] = []
    const customLoop = async (input: AgentInput | undefined): Promise<AgentRunResult> => {
      input ??= {}
      seen.push(input)
      return {
        input,
        output: 'custom',
        finishReason: 'stop',
        steps: [],
        messages: [...(input.messages ?? [])],
      }
    }
    await root.plugin(defineAgent({
      name: 'hooked',
      system: 'SYS',
      loop: customLoop,
      hooks: {
        beforeRun: async () => { events.push('before') },
        afterRun: async () => { events.push('after') },
      },
    }))

    const loop = root.get('agentLoop') as AgentLoop
    const result = await loop({ text: 'hi' })
    expect(result.output).toBe('custom')
    expect(seen[0]!.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'hi' },
    ])
    expect(events).toEqual(['before', 'after'])
  })

  it('emits agent/definition metadata', async () => {
    const root = await mountRoot()
    let payload: Record<string, unknown> | undefined
    root.on('agent/definition', (value: Record<string, unknown>) => {
      payload = value
    })
    await root.plugin(defineAgent({
      name: 'emitting',
      version: '1.2.3',
      tools: [customTool()],
      loop: async (input) => ({
        input: input ?? {},
        output: 'ok',
        finishReason: 'stop',
        steps: [],
        messages: [],
      }),
    }))

    expect(payload).toMatchObject({
      name: 'emitting',
      version: '1.2.3',
      toolCount: 1,
    })
  })

  it('mounts a default-loop definition without an LLM and rejects when run', async () => {
    const root = await mountRoot()
    const fiber = root.plugin(defineAgent({
      name: 'no-llm',
      system: 'SYS',
    }))
    await fiber
    expect(fiber.state).toBe(FiberState.ACTIVE)

    const loop = root.get('agentLoop') as AgentLoop
    await expect(loop({ text: 'x' })).rejects.toThrow(/LLM|llm/i)
  })

  it('runs beforeRun/afterRun hooks on the default loop', async () => {
    const root = await mountRoot()
    const events: string[] = []
    const seenInput: AgentInput[] = []
    const seenOptions: AgentRunOptions[] = []
    const seenResults: AgentRunResult[] = []
    const { adapter } = fakeLLM({ content: 'hooked', finishReason: 'stop' })
    await root.plugin(defineAgent({
      name: 'default-hooks',
      system: 'SYS',
      hooks: {
        beforeRun: async (input, options) => {
          events.push('before')
          seenInput.push(input)
          seenOptions.push(options)
        },
        afterRun: async (result, options) => {
          events.push('after')
          seenResults.push(result)
          seenOptions.push(options)
        },
      },
    }), { llm: adapter })

    const loop = root.get('agentLoop') as AgentLoop
    const result = await loop({ text: 'hello' }, { maxTurns: 3 })
    expect(result.output).toBe('hooked')
    expect(events).toEqual(['before', 'after'])
    expect(seenInput[0]).toEqual({ text: 'hello' })
    expect(seenResults[0]).toMatchObject({
      output: 'hooked',
      finishReason: 'stop',
    })
    expect(seenOptions).toHaveLength(2)
    expect(seenOptions[0]).toMatchObject({ maxTurns: 3 })
    expect(seenOptions[1]).toMatchObject({ maxTurns: 3 })
  })

  it('does not call afterRun when the default loop LLM throws', async () => {
    const root = await mountRoot()
    const events: string[] = []
    const { adapter } = fakeLLM({ content: 'x', finishReason: 'stop' })
    adapter.complete = async () => {
      throw new Error('llm boom')
    }
    await root.plugin(defineAgent({
      name: 'default-hooks-fail',
      hooks: {
        beforeRun: async () => { events.push('before') },
        afterRun: async () => { events.push('after') },
      },
    }), { llm: adapter })

    const loop = root.get('agentLoop') as AgentLoop
    await expect(loop({ text: 'hello' })).rejects.toThrow('llm boom')
    expect(events).toEqual(['before'])
  })

  it('disposes all definition-owned state including its internal agent fiber', async () => {
    const root = await mountRoot()
    const { adapter } = fakeLLM({ content: 'ok', finishReason: 'stop' })
    const fiber = root.plugin(defineAgent({
      name: 'lifecycle',
      system: 'SYS',
    }), { llm: adapter })
    await fiber

    const loop = root.get('agentLoop') as AgentLoop
    await loop({ text: 'a' })
    const log = dynamic(root).session as SessionLog
    const before = await log.deriveMessages()
    expect(before[0]).toMatchObject({ role: 'system', content: 'SYS' })

    await fiber.dispose()
    const after = await log.deriveMessages()
    expect(after).toHaveLength(before.length)
    expect(root.get('agentLoop')).toBeUndefined()
    expect(root.get('agentDefinition')).toBeUndefined()
  })
})
