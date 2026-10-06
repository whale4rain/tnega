import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { SessionLog } from '@tnega/session'
import { workspaceSessionDir } from '../src/home-paths.js'
import { storedWorkspaceUsage } from '../src/usage-store.js'

it('includes durable Project Thread responses with their identities', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'tnega-thread-usage-'))
  const directory = join(workspaceSessionDir(workspace), 'projects', 'project-one', 'agents', 'thread-one')
  await mkdir(directory, { recursive: true })
  const log = new SessionLog(join(directory, 'session.jsonl'))
  try {
    await log.init()
    await log.append('meta', { title: 'Research thread' })
    await log.append('assistant/message', { content: 'Done', usage: { promptTokens: 20, completionTokens: 5, cachedTokens: 10 } })
    await log.close()
    const unstarted = join(workspaceSessionDir(workspace), 'projects', 'project-one', 'agents', 'unstarted')
    await mkdir(unstarted, { recursive: true })
    const usage = await storedWorkspaceUsage(workspace, { model: 'mock' })
    expect(usage.total.promptTokens).toBe(20)
    expect(usage.responses).toEqual([expect.objectContaining({ projectId: 'project-one', threadId: 'thread-one', sessionTitle: 'Research thread' })])
    await expect(readFile(join(unstarted, 'session.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await log.close(); await rm(workspace, { recursive: true, force: true }) }
})
