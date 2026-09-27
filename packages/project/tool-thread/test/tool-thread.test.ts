import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import type { ToolsService } from '@tnega/tools'
import { agents } from '../../../agent/src/index.js'
import { blackboardLocal } from '../../blackboard-local/src/index.js'
import { boxBlackboard } from '../../box-blackboard/src/index.js'
import { threadLocal } from '../../thread-local/src/index.js'
import { toolThread } from '../src/index.js'
import { tools } from '../../../tools/src/index.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, {
    recursive: true, force: true, maxRetries: 10, retryDelay: 50,
  })))
})

const project = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Notes',
  coordinatorId: '11111111-1111-4111-8111-111111111111',
  goal: 'Track findings',
}
const llm = { complete: async () => ({ finishReason: 'stop' as const, content: 'ok' }) }

async function mount(): Promise<Context> {
  const root = await mkdtemp(join(tmpdir(), 'tnega-tool-thread-'))
  directories.push(root)
  const ctx = new Context()
  await ctx.plugin(tools)
  await ctx.plugin(blackboardLocal, { root: join(root, 'blackboard') })
  await ctx.plugin(boxBlackboard, { projectId: project.id })
  await ctx.plugin(agents)
  await ctx.plugin(threadLocal, { projectId: project.id, root, llm, permission: 'workspace-write' })
  await ctx.plugin(toolThread)
  return ctx
}

it('lets only the coordinator approve a direct child permission', async () => {
  const ctx = await mount()
  try {
    const coordinator = await ctx.threads.ensureRoot(project)
    const child = await ctx.threads.spawn({
      parentId: coordinator.id,
      goal: 'Review the release',
      permission: 'read-only',
    })
    const toolService = ctx.get('tools') as ToolsService

    expect(await toolService.execute('approve_thread_permission', {
      thread_id: child.id,
      permission: 'workspace-write',
    }, { agentId: coordinator.id })).toMatchObject({ ok: true })
    expect((await ctx.threads.get(child.id))?.permission).toBe('workspace-write')

    const grandchild = await ctx.threads.spawn({ parentId: child.id, goal: 'Check the diff' })
    expect(await toolService.execute('approve_thread_permission', {
      thread_id: grandchild.id,
      permission: 'workspace-write',
    }, { agentId: child.id })).toMatchObject({ ok: false })
  } finally {
    await ctx.fiber.dispose()
  }
})
