import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { runAgentCommand } from '../packages/cli/src/index.js'

const hasApiKey = Boolean(
  process.env.OPENCODE_GO_API_KEY
    || process.env.OPENAI_API_KEY
    || process.env.DEEPSEEK_API_KEY,
)

describe('OpenCode Go real smoke', () => {
  it.runIf(hasApiKey)('calls DeepSeek and persists a session without the key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tnega-deepseek-'))
    try {
      const result = await runAgentCommand({
        prompt: 'Reply with exactly: tnega-deepseek-ok',
        cwd: dir,
        maxTokens: 64,
      })
      expect(result.run.output).toContain('tnega-deepseek-ok')
      expect(result.run.finishReason).toBe('stop')
      expect(result.sessionFile).toContain('run.jsonl')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
