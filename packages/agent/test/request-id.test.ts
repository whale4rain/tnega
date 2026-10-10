import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { tools } from '@tnega/tools'
import { agents, type AgentRegistry, type LLMAdapter } from '../src/index.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function open(file: string, llm: LLMAdapter, resume = false) {
  const root = new Context()
  await root.plugin(tools)
  await root.plugin(agents)
  const registry = (root as unknown as { agents: AgentRegistry }).agents
  return resume ? registry.resume({ id: 'agent-1', file, llm }) : registry.create({ id: 'agent-1', file, llm })
}

it('admits a resubmitted request once, also after a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-request-id-'))
  dirs.push(dir)
  const file = join(dir, 'session.jsonl')
  const prompts: string[] = []
  const llm: LLMAdapter = { async complete(messages) {
    prompts.push(messages.filter(message => message.role === 'user').map(message => message.content).join('|'))
    return { content: 'ok', finishReason: 'stop' }
  } }

  const first = await open(file, llm)
  await first.agent.followup({ text: 'deploy', requestId: 'request-0001' })
  await first.agent.followup({ text: 'deploy', requestId: 'request-0001' })
  await first.agent.whenIdle()
  await first.dispose()

  const again = await open(file, llm, true)
  await again.agent.followup({ text: 'deploy', requestId: 'request-0001' })
  await again.agent.steer({ text: 'deploy', requestId: 'request-0001' })
  await again.agent.whenIdle()
  expect(prompts).toEqual(['deploy'])
  await again.agent.followup({ text: 'next', requestId: 'request-0002' })
  await again.agent.whenIdle()
  expect(prompts).toEqual(['deploy', 'deploy|next'])
  await again.dispose()
})
