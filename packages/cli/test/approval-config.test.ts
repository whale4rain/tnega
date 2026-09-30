import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionLog } from '@tnega/session'
import { describe, expect, it } from 'vitest'
import { readSystemConfig, updateSystemConfig } from '../src/config.js'
import { createSession, forkSession, readSessionSummary, setSessionApprovalMode, sessionFile } from '../src/store.js'

describe('approval configuration', () => {
  it.each([undefined, 'deepseek-flash'])('reviewer model does not overwrite conversation model %s, including after fork', async model => {
    const dir = await mkdtemp(join(tmpdir(), 'tnega-review-model-'))
    try {
      const session = await createSession(dir, { mode: 'plan', ...(model ? { model } : {}) })
      await setSessionApprovalMode(dir, session.id, 'auto')
      const log = new SessionLog(sessionFile(dir, session.id))
      await log.init()
      await log.append('meta', { kind: 'approval/review', decision: 'ask', provider: 'jev', model: 'jev-1.13.0', reason: 'Manual approval required' })
      await log.close()
      expect((await readSessionSummary(dir, session.id)).model).toBe(model)
      expect((await readSessionSummary(dir, session.id)).mode).toBe('plan')
      const fork = await forkSession(dir, session.id)
      expect((await readSessionSummary(dir, fork.id)).model).toBe(model)
      expect((await readSessionSummary(dir, fork.id)).mode).toBe('plan')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it('persists independent provider settings without changing tool permissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tnega-review-'))
    try {
      const file = join(dir, 'config.json')
      await updateSystemConfig({ approvalReview: { provider: 'jev', model: 'jev-latest', apiKeyEnv: 'TYPESAFE_API_KEY', defaultMode: 'auto' } }, file)
      expect((await readSystemConfig(file)).approvalReview).toMatchObject({ provider: 'jev', defaultMode: 'auto' })
      const session = await createSession(dir)
      await setSessionApprovalMode(dir, session.id, 'auto')
      const summary = await readSessionSummary(dir, session.id)
      expect(summary.approvalMode).toBe('auto')
      expect(summary.permission).toBe('read-only')
      const fork = await forkSession(dir, session.id)
      expect((await readSessionSummary(dir, fork.id)).approvalMode).toBe('auto')
      expect(await readFile(file, 'utf8')).toContain('TYPESAFE_API_KEY')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
