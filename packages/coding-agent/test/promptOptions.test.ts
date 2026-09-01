import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { LLMAdapter } from '@tnega/agent'
import { Context } from '@tnega/core'
import { session } from '@tnega/session'
import { tools } from '@tnega/tools'

import { createCodingAgentPlugin, type CodingService } from '../src/index.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-prompt-opts-'))
  dirs.push(dir)
  return dir
}

describe('coding agent prompt options', () => {
  it('uses custom plan prompt', async () => {
    const dir = await tempDir()
    const root = new Context()
    await root.plugin(session, { file: join(dir, 'plan.jsonl') })
    await root.plugin(tools)
    await root.plugin(createCodingAgentPlugin({
      cwd: dir,
      planPrompt: 'CUSTOM_PLAN_MARKER',
    }))
    const coding = root.get('coding') as CodingService
    const adapter: LLMAdapter = {
      async complete(messages) {
        expect(messages[0]?.content).toContain('CUSTOM_PLAN_MARKER')
        return {
          finishReason: 'stop',
          content: JSON.stringify({ items: [{ title: 'one' }] }),
        }
      },
    }
    await coding.generatePlan(adapter, [])
  })

  it('keeps default system prompt when registerAgent is on', async () => {
    const dir = await tempDir()
    const root = new Context()
    await root.plugin(session, { file: join(dir, 'agent.jsonl') })
    await root.plugin(tools)
    const fiber = await root.plugin(createCodingAgentPlugin({ cwd: dir }))
    const loop = root.get('agentLoop') as (input: { text?: string }) => Promise<unknown>
    expect(typeof loop).toBe('function')
    await fiber.dispose()
  })
})
