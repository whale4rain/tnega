import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { agent, type AgentPreStepEvent, type AgentService, type LLMAdapter } from '@tnega/agent'
import { Context } from '@tnega/core'
import { memoryLocal } from '@tnega/memory-local'
import { SessionLog } from '@tnega/session'
import { tools, type ToolsService } from '@tnega/tools'
import { consolidateProjectMemory, toolMemory } from '../src/index.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function setup() {
  const cwd = await mkdtemp(join(tmpdir(), 'tnega-tool-memory-'))
  directories.push(cwd)
  const root = new Context()
  await root.plugin(tools)
  await root.plugin(memoryLocal, { cwd, globalFile: join(cwd, 'global.md') })
  await root.plugin(toolMemory)
  const session = new SessionLog(join(cwd, '.tnega', 'sessions', 'test.jsonl'))
  await session.init()
  return { root, session }
}

it('loads both scopes into a replayable request prefix while preserving durable system history', async () => {
  const { root, session } = await setup()
  try {
    await root.memory.rememberGlobal('Prefers Chinese')
    await root.memory.writeProject('- Run pnpm lint')
    await session.append('system/message', { content: 'Coding persona' })
    const event: AgentPreStepEvent = {
      index: 0,
      messages: [{ role: 'system', content: 'Coding persona' }, { role: 'user', content: 'Hi' }],
      claimedMessages: [{ role: 'user', content: 'Hi' }],
    }
    const result = await root.waterfallAsync('agent/pre-step', event, async (payload: AgentPreStepEvent) => payload)
    expect(result?.messages[0]?.content).toContain('Prefers Chinese')
    expect(result?.messages[0]?.content).toContain('Run pnpm lint')
    expect(result?.messages[1]).toEqual({ role: 'system', content: 'Coding persona' })
    expect((await session.deriveMessages())[0]?.content).toBe('Coding persona')
  } finally {
    await session.close()
    await root.fiber.dispose()
  }
})

it('allows global writes only during a turn with an explicit memory request', async () => {
  const { root, session } = await setup()
  try {
    root.emit('agent/turn-start', {
      input: { text: 'How does memory work?' }, messages: [], injected: new Map(),
    })
    const registry = root.get('tools') as ToolsService
    expect((await registry.execute('remember_global', { content: 'Prefers Chinese' })).ok).toBe(false)
    root.emit('agent/turn-start', {
      input: { text: '请记住我喜欢中文回复' }, messages: [], injected: new Map(),
    })
    expect((await registry.execute('remember_global', { content: 'Prefers Chinese' })).ok).toBe(true)
    expect(await root.memory.read('global')).toContain('Prefers Chinese')
  } finally {
    await session.close()
    await root.fiber.dispose()
  }
})

it('curates project memory from compaction and skips an unchanged result', async () => {
  const { root, session } = await setup()
  try {
    const outputs = ['# Project memory\n\n- Use pnpm', 'NO_CHANGE']
    const llm: LLMAdapter = {
      async complete(messages) {
        expect(messages[1]?.content).toContain('User repeatedly asks for pnpm')
        return { content: outputs.shift() ?? 'NO_CHANGE', finishReason: 'stop' }
      },
    }
    expect(await consolidateProjectMemory(root.memory, llm, 'User repeatedly asks for pnpm')).toBe(true)
    expect(await root.memory.read('project')).toContain('Use pnpm')
    expect(await consolidateProjectMemory(root.memory, llm, 'User repeatedly asks for pnpm')).toBe(false)
  } finally {
    await session.close()
    await root.fiber.dispose()
  }
})

it('records the injected memory snapshot in the request header', async () => {
  const { root, session } = await setup()
  try {
    await root.memory.rememberGlobal('Prefers Chinese replies')
    const llm: LLMAdapter = {
      async complete(messages) {
        expect(messages[0]?.content).toContain('Prefers Chinese replies')
        return { content: '你好', finishReason: 'stop' }
      },
    }
    root.provide('session', session)
    await root.plugin(agent, { session, llm })
    const service = root.get('agent') as AgentService
    await service.run({ text: '你好' })
    expect(session.requestHeader()?.system).toContain('Prefers Chinese replies')
    expect((await session.deriveMessages()).map(message => message.content)).toEqual(['你好', '你好'])
  } finally {
    await session.close()
    await root.fiber.dispose()
  }
})

it('retains the coding persona as durable history when memory is injected', async () => {
  const { root, session } = await setup()
  try {
    await root.memory.writeProject('- Use pnpm')
    await session.append('system/message', { content: 'Coding persona' })
    const llm: LLMAdapter = {
      async complete(messages) {
        expect(messages[0]?.content).toContain('Use pnpm')
        expect(messages[1]?.content).toBe('Coding persona')
        return { content: 'done', finishReason: 'stop' }
      },
    }
    root.provide('session', session)
    await root.plugin(agent, { session, llm })
    const service = root.get('agent') as AgentService
    await service.run({ messages: [...await session.deriveMessages(), { role: 'user', content: 'go' }] })
    expect((await session.deriveMessages()).map(message => message.content))
      .toEqual(['Coding persona', 'go', 'done'])
  } finally {
    await session.close()
    await root.fiber.dispose()
  }
})
