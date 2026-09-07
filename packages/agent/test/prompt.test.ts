import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { Context } from '@tnega/core'
import { session } from '@tnega/session'
import { tools } from '@tnega/tools'

import {
  defineAgent,
  systemPrompt,
  type LLMAdapter,
  type LLMCompletion,
  type SystemPromptService,
} from '../src/index.js'

type DynamicContext = Context & {
  [key: string]: unknown
}

const dynamic = (ctx: Context): DynamicContext => ctx as unknown as DynamicContext

const dirs: string[] = []

async function tempFile(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-prompt-'))
  dirs.push(dir)
  return join(dir, name)
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function fakeLLM(): {
  adapter: LLMAdapter
  messages: Array<readonly import('@tnega/session').ModelMessage[]>
  toolInputs: Array<readonly { schema: { name: string; description: string } }[]>
} {
  const messages: Array<readonly import('@tnega/session').ModelMessage[]> = []
  const toolInputs: Array<readonly { schema: { name: string; description: string } }[]> = []
  return {
    adapter: {
      async complete(input, tools) {
        messages.push(input)
        toolInputs.push(tools as readonly { schema: { name: string; description: string } }[])
        return { content: 'ok', finishReason: 'stop' } satisfies LLMCompletion
      },
    },
    messages,
    toolInputs,
  }
}

async function mountRoot(): Promise<Context> {
  const root = new Context()
  await root.plugin(session, { file: await tempFile('prompt-session.jsonl') })
  await root.plugin(tools)
  await root.plugin(systemPrompt)
  return root
}

describe('system prompt assembly', () => {
  it('registers ordered sections and folds them into text', async () => {
    const root = await mountRoot()
    const service = dynamic(root).systemPrompt as SystemPromptService
    service.registerSection({ name: 'persona', content: 'You are Tnega.', order: 1 })
    service.registerSection({ name: 'facts', content: 'Keep edits small.', order: 2 })

    const assembly = await service.assemble()
    expect(assembly.sections.map(section => section.name)).toEqual(['persona', 'facts'])
    expect(assembly.text).toContain('You are Tnega.')
    expect(assembly.text).toContain('Keep edits small.')
  })

  it('emits change and lets listeners rewrite the assembled prompt', async () => {
    const root = await mountRoot()
    const service = dynamic(root).systemPrompt as SystemPromptService
    const changes: number[] = []
    root.on('system-prompt/change', () => changes.push(1))
    const dispose = service.registerSection({ name: 'persona', content: 'Base prompt.' })

    root.on('system-prompt/assemble', async (assembly: { text: string }, next: () => Promise<unknown>) => {
      const resolved = await next()
      if (resolved && typeof resolved === 'object' && 'text' in resolved) {
        ;(resolved as { text: string }).text = `${(resolved as { text: string }).text}\nExpert suffix.`
      }
      return resolved
    })
    const assembly = await service.assemble()
    expect(assembly.text).toBe('Base prompt.\nExpert suffix.')
    expect(changes).toEqual([1])

    dispose()
    expect(changes).toEqual([1, 1])
  })

  it('uses assembled prompt in the default loop when mounted', async () => {
    const root = await mountRoot()
    const { adapter, messages } = fakeLLM()
    await root.plugin(defineAgent({
      name: 'prompted',
      system: 'Assembled coding persona.',
    }), { llm: adapter })

    const loop = root.get('agentLoop') as (input: { text: string }) => Promise<unknown>
    await loop({ text: 'hello' })
    expect(messages[0]?.[0]).toMatchObject({
      role: 'system',
      content: 'Assembled coding persona.',
    })
    expect(messages[0]?.[1]).toEqual({ role: 'user', content: 'hello' })
  })

  it('assembles tool schemas and persists them in the request header', async () => {
    const root = await mountRoot()
    const service = dynamic(root).systemPrompt as SystemPromptService
    service.registerTools(() => [
      { name: 'read', description: 'read a file', parameters: { type: 'object' } },
    ])
    const { adapter, toolInputs } = fakeLLM()
    await root.plugin(defineAgent({
      name: 'tooled-prompt',
      system: 'You can read.',
    }), { llm: adapter })

    const loop = root.get('agentLoop') as (input: { text: string }) => Promise<unknown>
    await loop({ text: 'read it' })
    expect(toolInputs[0]?.[0]?.schema).toMatchObject({
      name: 'read',
      description: 'read a file',
      parameters: { type: 'object' },
    })

    const log = dynamic(root).session as import('@tnega/session').SessionLog
    const events = await log.read()
    const header = events.find(event => event.type === 'request/header')
    expect(header?.payload).toMatchObject({
      tools: [{ name: 'read', description: 'read a file' }],
    })
  })

  it('renders registered variables into section templates', async () => {
    const root = await mountRoot()
    const service = dynamic(root).systemPrompt as SystemPromptService
    service.registerSection({
      name: 'persona',
      content: 'Agent ${name} on workspace ${workspace}.',
    })
    service.registerVariable('name', () => 'tester')
    service.registerVariable('workspace', () => '/tmp/demo')

    const assembly = await service.assemble()
    expect(assembly.variables).toEqual({ name: 'tester', workspace: '/tmp/demo' })
    expect(assembly.text).toBe('Agent tester on workspace /tmp/demo.')
  })

  it('appends dynamic contexts in registration order', async () => {
    const root = await mountRoot()
    const service = dynamic(root).systemPrompt as SystemPromptService
    service.registerSection({ name: 'persona', content: 'Base.' })
    service.registerContext({
      name: 'repo',
      order: 2,
      content: () => 'Repo: ${repo}.',
    })
    service.registerContext({
      name: 'user',
      order: 1,
      content: () => 'User: tester.',
    })
    service.registerVariable('repo', () => 'tnega')

    const assembly = await service.assemble()
    expect(assembly.text).toBe('Base.\n\nUser: tester.\n\nRepo: tnega.')
  })
})
