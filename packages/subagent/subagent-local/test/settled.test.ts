import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { agents, type AgentRegistry, type LLMAdapter } from '@tnega/agent'
import { tools } from '@tnega/tools'
import { LocalSubagentService } from '../src/index.js'

const registryOf = (ctx: Context): AgentRegistry => (ctx as unknown as { agents: AgentRegistry }).agents

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

it('settles only once no child runs, so a host can hold a lease for them', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'tnega-subagent-settled-'))
  cleanup.push(() => rm(cwd, { recursive: true, force: true }))
  const root = new Context()
  await root.plugin(tools)
  await root.plugin(agents)
  let finish: () => void = () => undefined
  const gate = new Promise<void>(resolve => { finish = resolve })
  const llm: LLMAdapter = { async complete() {
    await gate
    return { content: 'done', finishReason: 'stop' }
  } }
  const parent = await registryOf(root).create({ id: 'parent', file: join(cwd, 'parent.jsonl'), llm, manualStreaming: true })
  cleanup.push(() => parent.dispose())
  const service = new LocalSubagentService(root, { cwd, llm })
  cleanup.push(() => service.dispose())

  // Nothing runs yet: settled at once.
  await service.settled()
  await service.start({ parentId: 'parent', task: 'slow work' })
  let settled = false
  void service.settled().then(() => { settled = true })
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(settled).toBe(false)
  finish()
  await expect.poll(() => settled).toBe(true)
})
