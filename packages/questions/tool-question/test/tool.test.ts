import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { SessionLog } from '@tnega/session'
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
