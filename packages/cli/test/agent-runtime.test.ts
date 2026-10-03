import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { Context, Plugin } from '@tnega/core'
import {
  AgentInbox,
  type AgentContextCompactEvent,
  type AgentLoop,
  type AgentRunOptions,
  type LLMAdapter,
  type LLMCompletion,
} from '@tnega/agent'
import type {
  ModelMessage,
} from '@tnega/session'
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

it('disposes answerer plugins mounted after runtime construction', async () => {
  const dir = await tempDir('tnega-runtime-late-plugin-')
  const runtime = await createAgentRuntime(runtimeOptions(dir, { builtinTools: false, ptc: { mode: 'native' } }))
  let disposed = false
  await runtime.root.plugin({
    name: 'late-answerer',
    apply(ctx: Context) { ctx.effect(() => () => { disposed = true }) },
  })
  await runtime.dispose()
  expect(disposed).toBe(true)
})

it('honors host PTC runtime limits when composing an agent', async () => {
  const dir = await tempDir('tnega-runtime-ptc-assets-')
  const runtime = await createAgentRuntime(runtimeOptions(dir, {
    builtinTools: false, ptcRuntime: { maxOutputChars: 4 },
  }))
  try {
    const result = await runtime.root.get('ptcRuntime').execute({ code: 'text("too long");', tools: [] })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/output/i)
  } finally {
    await runtime.dispose()
  }
})

describe('createAgentRuntime composition', () => {
  it('spills an oversized tool result and keeps the whole record on disk', async () => {
    const dir = await tempDir('tnega-runtime-spill-')
    const bytes = 60_000
    const { adapter, calls } = fakeLLM([
      {
        content: '',
        toolCalls: [{
          id: 'call_spill',
          name: 'shell',
          arguments: { command: `node -e "process.stdout.write('S'.repeat(${bytes}))"` },
        }],
        finishReason: 'tool_calls',
      },
      { content: 'done', finishReason: 'stop' },
    ])
    const runtime = await createAgentRuntime(runtimeOptions(dir, {
      llm: adapter,
      allowShell: true,
    }))
    try {
      const loop = runtime.root.get('agentLoop') as AgentLoop
      expect((await loop({ text: 'run it' })).output).toBe('done')

      // What the model was handed on the following request.
      const toolMessage = calls[1]!.messages.find(message => message.role === 'tool')
      expect(toolMessage).toBeTruthy()
      const content = String(toolMessage!.content)
      expect(content).toContain('Omitted')
      expect(content).toContain('.tnega/spill/')
      expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(50_000)
      expect(content).not.toContain('S'.repeat(50_000))

      // ...and the complete output, at exactly the locator it was handed.
      const locator = content.match(/stored at: (\S+)\./)?.[1]
      expect(locator).toBeTruthy()
      expect(await readFile(join(dir, locator!), 'utf8')).toContain('S'.repeat(bytes))
    } finally {
      await runtime.dispose()
    }
  }, 60_000)

  it('uses an injected inbox for queued inputs and injected context', async () => {
    const dir = await tempDir('tnega-runtime-inbox-')
    const inbox = new AgentInbox()
    inbox.inject('agentSystem', 'inbox system')
    inbox.push({ text: 'queued' })
    const { adapter, calls } = fakeLLM([{ content: 'claimed', finishReason: 'stop' }])
    const runtime = await createAgentRuntime(runtimeOptions(dir, {
      llm: adapter,
      builtinTools: false,
      inbox,
      agent: { name: 'inbox-agent' },
    }))
    try {
      const loop = runtime.root.get('agentLoop') as AgentLoop
      const result = await loop()
      expect(result.input).toEqual({ text: 'queued' })
      expect(inbox.size).toBe(0)
      expect(calls[0]!.messages[0]).toMatchObject({
        role: 'system',
        content: 'inbox system',
      })
    } finally {
      await runtime.dispose()
    }
  })

  it('uses an injected inbox on the default agent branch', async () => {
    const dir = await tempDir('tnega-runtime-inbox-default-')
    const inbox = new AgentInbox()
    inbox.inject('agentSystem', 'default inbox system')
    inbox.push({ text: 'queued default' })
    const { adapter, calls } = fakeLLM([{ content: 'claimed', finishReason: 'stop' }])
    const runtime = await createAgentRuntime(runtimeOptions(dir, {
      llm: adapter,
      builtinTools: false,
      inbox,
    }))
    try {
      const loop = runtime.root.get('agentLoop') as AgentLoop
      const result = await loop()
      expect(result.input).toEqual({ text: 'queued default' })
      expect(calls[0]!.messages).toMatchObject([
        { role: 'system', content: 'default inbox system' },
        { role: 'user', content: 'queued default' },
      ])
    } finally {
      await runtime.dispose()
    }
  })

  it('enforces a runtime context budget and emits compact events', async () => {
    const dir = await tempDir('tnega-runtime-budget-')
    const compactEvents: AgentContextCompactEvent[] = []
    const { adapter, calls } = fakeLLM([
      { content: '# Project memory\n\n- Use pnpm', finishReason: 'stop' },
      { content: 'stop', finishReason: 'stop' },
      { content: 'stop again', finishReason: 'stop' },
    ])
    const runtime = await createAgentRuntime(runtimeOptions(dir, {
      llm: adapter,
      builtinTools: false,
      contextBudget: {
        limit: 100,
        compactRatio: 0.1,
      },
    }))
    runtime.root.on('agent/context-compact', (value: AgentContextCompactEvent) => {
      compactEvents.push(value)
    })
    try {
      const loop = runtime.root.get('agentLoop') as AgentLoop
      const result = await loop({ text: 'z'.repeat(400) })
      expect(result.output).toBe('stop')
      expect(compactEvents).toHaveLength(1)
      expect(compactEvents[0]).toMatchObject({
        type: 'agent/context-compact',
        messagesBefore: 1,
        limit: 100,
      })
      expect(String(calls[1]!.messages.at(-1)?.content))
        .toContain('Earlier context was compacted.')
      expect(await readFile(join(dir, '.tnega', 'MEMORY.md'), 'utf8'))
        .toContain('- Use pnpm')
    } finally {
      await runtime.dispose()
    }
  })

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

it('offers installed skills and their trigger index in a general runtime', async () => {
  const dir = await tempDir('tnega-general-skills-')
  const runtime = await createAgentRuntime(runtimeOptions(dir, { ptc: { mode: 'native' } }))
  try {
    const registry = runtime.root.get('tools') as import('@tnega/tools').ToolsService
    expect(registry.has('skills_list')).toBe(true)
    expect(registry.has('skill_read')).toBe(true)
    const prompt = runtime.root.get('systemPrompt') as import('@tnega/agent').SystemPromptService
    expect((await prompt.assemble()).text).toContain('using-tnega')
    const listed = await registry.list().find(tool => tool.schema.name === 'skills_list')!.execute({}, {})
    expect(listed).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'implementing-changes' })]))
  } finally {
    await runtime.dispose()
  }
})

it.each(['native', 'ptc'] as const)('discovers skills in an older Session through %s tool metadata without rewriting history', async mode => {
  const dir = await tempDir('tnega-legacy-skills-')
  const mock = fakeLLM([{ content: 'done', finishReason: 'stop' }])
  const runtime = await createAgentRuntime(runtimeOptions(dir, { llm: mock.adapter, ptc: { mode } }))
  try {
    const loop = runtime.root.get('agentLoop') as AgentLoop
    await loop({ messages: [{ role: 'system', content: 'Legacy persona.' }, { role: 'user', content: 'Help with coding.' }] })
    expect(mock.calls[0]?.messages[0]?.content).toBe('Legacy persona.')
    const name = mode === 'native' ? 'skills_list' : 'run_code'
    expect(mock.calls[0]?.tools.find(tool => tool.schema.name === name)?.schema.description).toContain('using-tnega')
    expect(mock.calls[0]?.tools.find(tool => tool.schema.name === name)?.schema.description).toContain('implementing-changes')
  } finally { await runtime.dispose() }
})
