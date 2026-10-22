import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { SessionLog } from '@tnega/session'
import { workspaceSessionDir } from '@tnega/home'
import { createSession, deleteSession, sessionFile } from '@tnega/session-store'
import { ContextReportStore } from '../src/index.js'

const config = { model: 'mock', models: [{ id: 'mock', model: 'mock', contextWindow: 50_000, pricing: { input: 1, output: 2 } }] }

async function write(file: string, fill: (log: SessionLog) => Promise<unknown>) {
  const log = new SessionLog(file)
  await log.init()
  try { await fill(log) } finally { await log.close() }
}

it('reports sessions and Project threads, and rebuilds a report only when its log changes', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'tnega-context-store-'))
  const store = new ContextReportStore()
  try {
    const session = await createSession(workspace, { title: 'Parser fix', model: 'mock' })
    await write(sessionFile(workspace, session.id), async log => {
      await log.append('user/message', { content: 'fix it' })
      await log.append('assistant/message', { content: 'done', usage: { promptTokens: 40, completionTokens: 4 } })
    })
    const thread = join(workspaceSessionDir(workspace), 'projects', 'p1', 'agents', 't1')
    await mkdir(thread, { recursive: true })
    await write(join(thread, 'session.jsonl'), async log => {
      await log.append('meta', { title: 'Research thread' })
      await log.append('assistant/message', { content: 'found it', usage: { promptTokens: 20, completionTokens: 5 } })
    })

    const sources = await store.workspace(workspace, config)
    expect(sources.map(source => [source.kind, source.report.title]).sort()).toEqual([['session', 'Parser fix'], ['thread', 'Research thread']])
    expect(sources.find(source => source.kind === 'thread')).toMatchObject({ id: 'p1/t1', projectId: 'p1', threadId: 't1' })

    const first = await store.session(workspace, session.id, config)
    expect(first?.window).toBe(50_000)
    expect(await store.session(workspace, session.id, config)).toBe(first)
    await write(sessionFile(workspace, session.id), log => log.append('assistant/message', { content: 'more', usage: { promptTokens: 60, completionTokens: 6 } }))
    const second = await store.session(workspace, session.id, config)
    expect(second).not.toBe(first)
    expect(second?.stats.steps).toBe(2)

    await deleteSession(workspace, session.id)
    expect((await store.workspace(workspace, config)).map(source => source.kind)).toEqual(['thread'])
  } finally {
    store.clear()
    await rm(workspace, { recursive: true, force: true })
  }
})
