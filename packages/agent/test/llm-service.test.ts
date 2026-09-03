import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { Context } from '@tnega/core'
import { session } from '@tnega/session'
import { tools } from '@tnega/tools'

import {
  agent,
  llmService,
  type AgentService,
  type LLMAdapter,
  type LlmService,
} from '../src/index.js'

type DynamicContext = Context & {
  [key: string]: unknown
}

const dynamic = (ctx: Context): DynamicContext => ctx as unknown as DynamicContext

const dirs: string[] = []

async function tempFile(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-llm-seam-'))
  dirs.push(dir)
  return join(dir, name)
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function namedAdapter(content: string): LLMAdapter {
  return {
    async complete() {
      return { content, finishReason: 'stop' }
    },
  }
}

describe('llm service seam', () => {
  it('registers, lists and switches providers', async () => {
    const root = new Context()
    await root.plugin(llmService)
    const service = dynamic(root).llm as LlmService
    service.register('alpha', namedAdapter('alpha'))
    service.register('beta', namedAdapter('beta'))

    expect(service.current()).toBeDefined()
    expect(service.list()).toHaveLength(2)
    expect(service.setCurrent('beta')).toBeDefined()
  })

  it('falls back to the ctx llm provider when config has none', async () => {
    const root = new Context()
    await root.plugin(session, { file: await tempFile('llm-seam.jsonl') })
    await root.plugin(tools)
    await root.plugin(llmService)
    const service = dynamic(root).llm as LlmService
    service.register('primary', namedAdapter('from ctx llm'))
    await root.plugin(agent)

    const agentService = dynamic(root).agent as AgentService
    const result = await agentService.run({ text: 'hello' })
    expect(result.output).toBe('from ctx llm')
  })
})
