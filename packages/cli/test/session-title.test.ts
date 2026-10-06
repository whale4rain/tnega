import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { SessionLog, foldSessionMeta } from '@tnega/session'
import type { LLMAdapter } from '@tnega/agent'
import { autoNameSession } from '../src/session-title.js'

it('persists an intent summary once and preserves a rename made during generation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tnega-title-'))
  const log = new SessionLog(join(directory, 'session.jsonl'))
  const complete = vi.fn<LLMAdapter['complete']>(async () => ({ content: 'Repair login flow', finishReason: 'stop' }))
  try {
    await log.init()
    await log.append('meta', { title: 'New session' })
    await log.append('user/message', { content: 'Please investigate and repair our login flow' })
    await log.append('assistant/message', { content: 'Fixed the login issue.' })
    await autoNameSession(log, { complete })
    expect(foldSessionMeta(await log.read()).title).toBe('Repair login flow')
    await autoNameSession(log, { complete })
    expect(complete).toHaveBeenCalledTimes(1)
    await log.close()
    const reopened = new SessionLog(log.file)
    await reopened.init()
    expect(foldSessionMeta(await reopened.read()).title).toBe('Repair login flow')
    await reopened.close()
    const second = new SessionLog(join(directory, 'race.jsonl'))
    await second.init()
    await second.append('meta', { title: 'New session' })
    await second.append('user/message', { content: 'Fix login' })
    await second.append('assistant/message', { content: 'Done.' })
    await autoNameSession(second, { complete: async () => {
      await second.append('meta/patch', { fields: ['title'], title: 'My chosen name' })
      return { content: 'Generated name', finishReason: 'stop' }
    } })
    expect(foldSessionMeta(await second.read()).title).toBe('My chosen name')
    await second.close()
  } finally { await log.close(); await rm(directory, { recursive: true, force: true }) }
})

it('keeps the default title on provider failure and preserves manually reset names', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tnega-title-failure-'))
  const log = new SessionLog(join(directory, 'session.jsonl'))
  try {
    await log.init()
    await log.append('meta', { title: 'New session' })
    await log.append('user/message', { content: 'Fix login' })
    await log.append('assistant/message', { content: 'Done.' })
    await autoNameSession(log, { complete: async () => { throw new Error('offline') } })
    expect(foldSessionMeta(await log.read()).title).toBe('New session')
    const complete = vi.fn<LLMAdapter['complete']>()
    await log.append('meta/patch', { fields: ['title'], title: 'New session' })
    await autoNameSession(log, { complete })
    expect(complete).not.toHaveBeenCalled()
  } finally { await log.close(); await rm(directory, { recursive: true, force: true }) }
})
