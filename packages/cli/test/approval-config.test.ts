import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readSystemConfig, updateSystemConfig } from '../src/config.js'
import { createSession, forkSession, readSessionSummary, setSessionApprovalMode } from '../src/store.js'

describe('approval configuration', () => {
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
