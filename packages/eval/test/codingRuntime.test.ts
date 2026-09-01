import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { LLMAdapter } from '@tnega/agent'

import { createCodingEvalRuntime } from '../src/codingRuntime.js'
import { createEvalToolPolicy } from '../src/policy.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function adapter(reply: (messages: readonly { role?: string }[]) => string): LLMAdapter {
  return {
    async complete(messages) {
      return {
        finishReason: 'stop',
        content: reply(messages),
      }
    },
  }
}

describe('coding runtime', () => {
  it('runs a coding agent and persists a session trace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tnega-coding-run-'))
    dirs.push(dir)
    const sessionFile = join(dir, 'trial.jsonl')
    const runtime = await createCodingEvalRuntime({
      cwd: dir,
      sessionFile,
      toolPolicy: createEvalToolPolicy({ workspace: dir }),
      config: {
        llm: adapter(() => 'ok'),
        agent: { systemPrompt: 'You are a test coding agent.' },
        coding: { skills: false, planTools: false, mcp: false },
      },
    })
    try {
      const result = await runtime.loop({ text: 'hello' })
      expect(result.output.length).toBeGreaterThan(0)
      const sessionLog = runtime.root.get('session') as { flush(): Promise<number> }
      await sessionLog.flush()
      const trace = await readFile(sessionFile, 'utf8')
      expect(trace).toContain('user/message')
    } finally {
      await runtime.dispose()
    }
  })

  it('registers shell only when allowed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tnega-coding-run-'))
    dirs.push(dir)
    const runtime = await createCodingEvalRuntime({
      cwd: dir,
      sessionFile: join(dir, 'trial.jsonl'),
      toolPolicy: createEvalToolPolicy({
        workspace: dir,
        permissions: { shell: { enabled: true, allow: ['pytest'] } },
      }),
      allowShell: true,
      config: {
        llm: adapter(() => 'ok'),
        coding: { skills: false, planTools: false, mcp: false },
      },
    })
    try {
      const toolsService = runtime.root.get('tools') as { list(): Array<{ schema: { name: string } }> }
      const names = toolsService.list().map(tool => tool.schema.name)
      expect(names).toContain('shell')
    } finally {
      await runtime.dispose()
    }
  })
})
