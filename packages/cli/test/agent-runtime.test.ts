import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { Context, Plugin } from '@tnega/core'
import type {
  AgentLoop,
  AgentRunOptions,
  LLMAdapter,
  LLMCompletion,
} from '@tnega/agent'
import type { ModelMessage, SessionEvent } from '@tnega/session'
import type { ToolDefinition, ToolPolicy } from '@tnega/tools'

import {
  createAgentRuntime,
  type AgentRuntimeOptions,
} from '../src/index.js'

type DynamicContext = Context & {
  [key: string]: unknown
}

const dynamic = (ctx: Context): DynamicContext => ctx as unknown as DynamicContext

const dirs: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function fakeLLM(sequence: readonly LLMCompletion[]): {
  adapter: LLMAdapter
  calls: Array<{ messages: readonly ModelMessage[]; tools: readonly ToolDefinition[] }>
} {
  const calls: Array<{ messages: readonly ModelMessage[]; tools: readonly ToolDefinition[] }> = []
  let index = 0
  return {
    adapter: {
      async complete(messages, tools) {
        calls.push({ messages, tools })
        return sequence[Math.min(index++, sequence.length - 1)]!
      },
    },
    calls,
  }
}

function runtimeOptions(
  dir: string,
  overrides: Partial<AgentRuntimeOptions> = {},
): AgentRuntimeOptions {
  return {
    cwd: dir,
    sessionFile: join(dir, 'runtime.jsonl'),
    ...overrides,
  }
}

function pingTool(): ToolDefinition {
  return {
    schema: {
      name: 'runtime_ping',
      description: 'returns pong',
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'string' },
        },
      },
    },
    execute: () => 'pong',
  }
}

describe('createAgentRuntime composition', () => {
  it('mounts an injected AgentDefinition with custom tools and no builtin tools', async () => {
    const dir = await tempDir('tnega-runtime-agent-')
    const events: string[] = []
    const seenOptions: AgentRunOptions[] = []
    const { adapter, calls } = fakeLLM([
      {
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [{ id: 't1', name: 'runtime_ping', arguments: {} }],
      },
      { content: 'pong received', finishReason: 'stop' },
    ])
    const runtime = await createAgentRuntime(runtimeOptions(dir, {
      llm: adapter,
      builtinTools: false,
      maxTurns: 2,
      agent: {
        name: 'external-agent',
        system: 'external system',
        tools: [pingTool()],
        hooks: {
          beforeRun: async (_input, options) => {
            events.push('before')
            seenOptions.push(options)
          },
          afterRun: async (_result, options) => {
            events.push('after')
            seenOptions.push(options)
          },
        },
      },
    }))
    try {
      const services = dynamic(runtime.root).tools as {
        has(name: string): boolean
        list(): readonly ToolDefinition[]
      }
      expect(services.has('runtime_ping')).toBe(true)
      expect(services.has('echo')).toBe(false)
      expect(services.list().map(tool => tool.schema.name)).toEqual(['runtime_ping'])

      const loop = runtime.root.get('agentLoop') as AgentLoop
      const result = await loop({ text: 'hello' }, { maxTurns: 2 })
      expect(result.output).toBe('pong received')
      expect(result.finishReason).toBe('stop')
      expect(result.steps).toHaveLength(2)
      expect(calls).toHaveLength(2)
      expect(events).toEqual(['before', 'after'])
      expect(seenOptions).toHaveLength(2)
      expect(seenOptions[0]).toMatchObject({ maxTurns: 2 })
      expect(calls[0]!.messages[0]).toMatchObject({
        role: 'system',
        content: 'external system',
      })
      expect(calls[0]!.tools.map(tool => tool.schema.name)).toEqual(['runtime_ping'])
      expect(calls[1]!.messages.at(-1)).toMatchObject({
        role: 'tool',
        content: 'pong',
      })
    } finally {
      await runtime.dispose()
    }
  })

  it('applies tool policy to custom tools', async () => {
    const dir = await tempDir('tnega-runtime-policy-')
    const authorized: string[] = []
    const validated: unknown[] = []
    const policy: ToolPolicy = {
      authorizer: async request => {
        authorized.push(request.input as string)
        return (request.input as { value: string }).value !== 'secret'
      },
      validator: async (input, tool) => {
        validated.push(input)
        if ((input as { value: string }).value === 'bad') {
          throw new Error(`invalid for ${tool.schema.name}`)
        }
      },
      truncator: async result => ({
        ...result,
        output: `${String(result.output)}-trunc`,
      }),
    }
    const { adapter, calls } = fakeLLM([
      {
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [
          { id: 't1', name: 'runtime_ping', arguments: { value: 'ok' } },
          { id: 't2', name: 'runtime_ping', arguments: { value: 'secret' } },
          { id: 't3', name: 'runtime_ping', arguments: { value: 'bad' } },
        ],
      },
      { content: 'reviewed', finishReason: 'stop' },
    ])
    const runtime = await createAgentRuntime(runtimeOptions(dir, {
      llm: adapter,
      builtinTools: false,
      maxTurns: 2,
      toolPolicy: policy,
      agent: {
        name: 'policy-agent',
        tools: [pingTool()],
      },
    }))
    try {
      const loop = runtime.root.get('agentLoop') as AgentLoop
      const result = await loop({ text: 'go' })
      expect(result.output).toBe('reviewed')
      expect(result.finishReason).toBe('stop')
      expect(result.steps).toHaveLength(2)
      expect(calls).toHaveLength(2)
      expect(authorized).toEqual([
        { value: 'ok' },
        { value: 'secret' },
        { value: 'bad' },
      ])
      expect(validated).toEqual([
        { value: 'ok' },
        { value: 'bad' },
      ])
      const toolMessages = result.messages.filter(message => message.role === 'tool')
      expect(toolMessages).toHaveLength(3)
      expect(toolMessages[0]).toMatchObject({
        role: 'tool',
        content: 'pong-trunc',
      })
      expect(String(toolMessages[1]?.content)).toContain('authorization denied')
      expect(String(toolMessages[2]?.content)).toContain('invalid for runtime_ping')
      expect(calls[1]!.messages.filter(message => message.role === 'tool'))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ role: 'tool', content: 'pong-trunc' }),
        ]))
    } finally {
      await runtime.dispose()
    }
  })

  it('uses the injected session projector for derived messages', async () => {
    const dir = await tempDir('tnega-runtime-projector-')
    const { adapter } = fakeLLM([{ content: 'projected', finishReason: 'stop' }])
    const projector = (events: readonly SessionEvent[]): ModelMessage[] => [
      {
        role: 'user',
        content: `projected ${events.length} events`,
      },
    ]
    const runtime = await createAgentRuntime(runtimeOptions(dir, {
      llm: adapter,
      builtinTools: false,
      sessionProjector: projector,
      agent: { name: 'projector-agent' },
    }))
    try {
      const loop = runtime.root.get('agentLoop') as AgentLoop
      await loop({ text: 'hello' })
      const session = dynamic(runtime.root).session as {
        deriveMessages(): Promise<readonly ModelMessage[]>
      }
      const messages = await session.deriveMessages()
      expect(messages).toEqual([
        { role: 'user', content: expect.stringContaining('projected') },
      ])
    } finally {
      await runtime.dispose()
    }
  })

  it('mounts extra plugins and clears their services on dispose', async () => {
    const dir = await tempDir('tnega-runtime-plugin-')
    const { adapter } = fakeLLM([{ content: 'ok', finishReason: 'stop' }])
    const external: Plugin = {
      name: 'external',
      apply: (ctx) => {
        ctx.provide('externalService', { label: 'from-plugin' })
      },
    }
    const runtime = await createAgentRuntime(runtimeOptions(dir, {
      llm: adapter,
      builtinTools: false,
      agent: { name: 'plugin-agent' },
      plugins: [external],
    }))

    expect(runtime.root.get('externalService')).toEqual({ label: 'from-plugin' })
    await runtime.dispose()
    expect(runtime.root.get('externalService')).toBeUndefined()
    expect(runtime.root.get('agentLoop')).toBeUndefined()
  })

  it('merges builtinTools config with runtime flags and only registers builtins', async () => {
    const dir = await tempDir('tnega-runtime-builtins-')
    const { adapter } = fakeLLM([{ content: 'ok', finishReason: 'stop' }])
    const runtime = await createAgentRuntime(runtimeOptions(dir, {
      llm: adapter,
      allowShell: true,
      builtinTools: { disabled: ['calculator'] },
      agent: { name: 'builtin-agent' },
    }))
    try {
      const services = dynamic(runtime.root).tools as {
        has(name: string): boolean
      }
      expect(services.has('echo')).toBe(true)
      expect(services.has('shell')).toBe(true)
      expect(services.has('calculator')).toBe(false)
    } finally {
      await runtime.dispose()
    }
  })
})
