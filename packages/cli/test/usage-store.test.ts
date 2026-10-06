import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { SessionLog } from '@tnega/session'
import { workspaceSessionDir, workspaceStateDir } from '../src/home-paths.js'
import { createSession, sessionFile } from '../src/store.js'
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

it('persists token-only summaries and reuses unchanged histories across pricing changes', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'tnega-cached-usage-'))
  const session = await createSession(workspace, { title: 'Cached session', model: 'mock' })
  const log = new SessionLog(sessionFile(workspace, session.id))
  const config = { model: 'mock', models: [{ id: 'mock', pricing: { input: 1, output: 2 } }] }
  const cacheFile = join(workspaceStateDir(workspace), 'usage-cache.json')
  try {
    await log.init()
    await log.append('assistant/message', { content: 'private conversation', usage: { promptTokens: 20, completionTokens: 5 } })
    await log.close()
    const first = await storedWorkspaceUsage(workspace, config)
    const cache = await readFile(cacheFile, 'utf8')
    expect(cache).not.toContain('private conversation')
    const read = vi.spyOn(SessionLog.prototype, 'read')
    try {
      expect(await storedWorkspaceUsage(workspace, config)).toEqual(first)
      expect(read).not.toHaveBeenCalled()
      const repriced = await storedWorkspaceUsage(workspace, { ...config, models: [{ id: 'mock', pricing: { input: 2, output: 4 } }] })
      expect(repriced.total.cost?.[0]?.amount).toBeCloseTo(0.00006)
      expect(read).not.toHaveBeenCalled()
      expect(await readFile(cacheFile, 'utf8')).not.toBe(cache)
    } finally { read.mockRestore() }
    await writeFile(cacheFile, '{broken', 'utf8')
    expect(await storedWorkspaceUsage(workspace, config)).toEqual(first)
    await log.init()
    await log.append('assistant/message', { content: 'new', usage: { promptTokens: 10, completionTokens: 2 } })
    expect((await storedWorkspaceUsage(workspace, config)).total.responses).toBe(2)
    await log.append('meta/patch', { fields: ['title'], title: 'Renamed session' })
    expect((await storedWorkspaceUsage(workspace, config)).responses.every(response => response.sessionTitle === 'Renamed session')).toBe(true)
    await log.close()
    await rm(sessionFile(workspace, session.id))
    expect((await storedWorkspaceUsage(workspace, config)).total.responses).toBe(0)
  } finally { await log.close(); await rm(workspace, { recursive: true, force: true }) }
})

it('rebuilds day buckets when the local timezone changes', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'tnega-usage-timezone-'))
  const previousTimezone = process.env.TZ
  process.env.TZ = 'UTC'
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 6, 1))
  const session = await createSession(workspace, { model: 'mock' })
  const log = new SessionLog(sessionFile(workspace, session.id))
  try {
    await log.init()
    await log.append('assistant/message', { content: '', usage: { promptTokens: 10, completionTokens: 2 } })
    await log.close()
    clock.mockReturnValue(Date.UTC(2026, 9, 6, 12))
    expect((await storedWorkspaceUsage(workspace, { model: 'mock' })).today.responses).toBe(1)
    process.env.TZ = 'America/New_York'
    const read = vi.spyOn(SessionLog.prototype, 'read')
    try {
      expect((await storedWorkspaceUsage(workspace, { model: 'mock' })).today.responses).toBe(0)
      expect(read).not.toHaveBeenCalled()
    } finally { read.mockRestore() }
  } finally {
    clock.mockRestore()
    if (previousTimezone === undefined) delete process.env.TZ
    else process.env.TZ = previousTimezone
    await log.close()
    await rm(workspace, { recursive: true, force: true })
  }
})

it('reuses old day aggregates across midnight and preserves partial cache accounting', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'tnega-usage-days-'))
  const clock = vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 9, 5, 12).getTime())
  const session = await createSession(workspace, { model: 'mock' })
  const log = new SessionLog(sessionFile(workspace, session.id))
  try {
    await log.init()
    await log.append('assistant/message', { content: '', usage: { promptTokens: 100, completionTokens: 0 } })
    await log.append('assistant/message', { content: '', usage: { promptTokens: 20, completionTokens: 0, cachedTokens: 0 } })
    await log.close()
    const first = await storedWorkspaceUsage(workspace, { model: 'mock' })
    expect(first.today.responses).toBe(2)
    const cacheFile = join(workspaceStateDir(workspace), 'usage-cache.json')
    const previousCache = await readFile(cacheFile, 'utf8')
    const read = vi.spyOn(SessionLog.prototype, 'read')
    try {
      clock.mockReturnValue(new Date(2026, 9, 6, 12).getTime())
      const next = await storedWorkspaceUsage(workspace, { model: 'mock' })
      expect(next.today.responses).toBe(0)
      expect(next.week).toEqual(first.week)
      expect(await readFile(cacheFile, 'utf8')).toBe(previousCache)
      expect(read).not.toHaveBeenCalled()
    } finally { read.mockRestore() }
    const second = await createSession(workspace, { model: 'mock' })
    const secondLog = new SessionLog(sessionFile(workspace, second.id))
    try {
      await secondLog.init()
      await secondLog.append('assistant/message', { content: '', usage: { promptTokens: 20, completionTokens: 0, cachedTokens: 10 } })
      const combined = await storedWorkspaceUsage(workspace, { model: 'mock' })
      expect(combined.total.cacheHitRate).toBe(0.25)
      expect(combined.week.cacheHitRate).toBe(0.25)
      expect(combined.byModel[0]?.cacheHitRate).toBe(0.25)
    } finally { await secondLog.close() }
  } finally { clock.mockRestore(); await log.close(); await rm(workspace, { recursive: true, force: true }) }
})
