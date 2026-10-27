import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { SessionLog } from '@tnega/session'
import { SecretStore, type SecretEntry, type SecretInfo } from '@tnega/secrets'
import { tools, type ToolsService } from '@tnega/tools'
import { userQuestions } from '@tnega/user-questions'
import { toolQuestion } from '../src/index.js'

it('registers a question tool, passes ownership and removes it on disposal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tnega-question-tool-'))
  const session = new SessionLog(join(directory, 'session.jsonl'))
  await session.init()
  const root = new Context()
  await root.plugin(tools)
  const registry: ToolsService = root.get('tools')
  const service = root.plugin(userQuestions, { resolveSession: () => session })
  await service
  const tool = root.plugin(toolQuestion, { agentId: 'owner' })
  await tool
  try {
    const result = await registry.execute('ask_user_question', { mode: 'nonblocking', questions: [{ id: 'q' }] }, { callId: 'c' })
    expect(result).toMatchObject({ ok: true, output: { status: 'pending', agentId: 'owner', callId: 'c' } })
    await expect(registry.execute('ask_user_question', { questions: [{ id: 'q' }, { id: 'q' }] }, { agentId: 'owner' })).resolves.toMatchObject({ ok: false })
    await tool.dispose()
    expect(registry.list().some(tool => tool.schema.name === 'ask_user_question')).toBe(false)
  } finally { await service.dispose(); await rm(directory, { recursive: true, force: true }) }
})

it('tells the model how to use a secret it was given, without the value', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tnega-question-tool-'))
  const session = new SessionLog(join(directory, 'session.jsonl'))
  await session.init()
  const root = new Context()
  await root.plugin(tools)
  const stored = new Map<string, string>()
  await root.plugin({ name: 'memory-secrets', apply: (ctx: Context) => {
    new class extends SecretStore {
      override async set(name: string, value: string): Promise<SecretInfo> { stored.set(name, value); return { name, remembered: false } }
      override async remove(name: string) { return stored.delete(name) }
      override async list() { return [...stored.keys()].map(name => ({ name, remembered: false })) }
      override async entries(): Promise<SecretEntry[]> { return [...stored].map(([name, value]) => ({ name, value })) }
    }(ctx)
  } })
  const service = root.plugin(userQuestions, { resolveSession: () => session })
  await service
  await root.plugin(toolQuestion, { agentId: 'owner' })
  const registry: ToolsService = root.get('tools')
  try {
    const running = registry.execute('ask_user_question', { questions: [{ id: 'k', secret: 'API_KEY' }] }, { callId: 'c' })
    let pending
    for (let i = 0; i < 100 && !pending; i++) {
      pending = (await root.userQuestions.listPending('owner'))[0]
      if (!pending) await new Promise(resolve => setTimeout(resolve, 2))
    }
    if (!pending) throw new Error('question did not open')
    await root.userQuestions.answer(pending.requestId, [{ questionId: 'k', text: 'value-abcdef' }], { agentId: 'owner' })
    const result = await running
    expect(result.ok).toBe(true)
    expect(JSON.stringify(result.output)).toContain('$API_KEY')
    expect(JSON.stringify(result.output)).not.toContain('value-abcdef')
    expect(stored.get('API_KEY')).toBe('value-abcdef')
  } finally { await service.dispose(); await rm(directory, { recursive: true, force: true }) }
})
