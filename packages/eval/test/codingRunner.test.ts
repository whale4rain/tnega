import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { agent } from '@tnega/agent'
import type { LLMAdapter } from '@tnega/agent'
import { Context } from '@tnega/core'
import { session } from '@tnega/session'
import { tools } from '@tnega/tools'

import {
  evalPlugin,
  type EvalRunOptions,
  type EvalService,
  type Task,
} from '../src/index.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function setup(outputDir: string): Promise<{ service: EvalService; dispose: () => Promise<void> }> {
  const root = new Context()
  await root.plugin(session, { file: join(outputDir, 'root.jsonl') })
  await root.plugin(tools)
  await root.plugin(agent)
  await root.plugin(evalPlugin, { outputDir })
  return {
    service: root.get('eval') as EvalService,
    dispose: () => root.fiber.dispose(),
  }
}

describe('coding eval runner', () => {
  it('runs trials, writes traces and aggregates verdicts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tnega-coding-eval-'))
    dirs.push(dir)
    const outputDir = join(dir, 'runs')
    const fixtureDir = join(dir, 'fixture')
    await mkdir(fixtureDir, { recursive: true })
    await writeFile(join(fixtureDir, 'task.txt'), 'x', 'utf8')

    const tasks: Task[] = [{
      id: 'write-answer',
      inputText: 'write answer.txt containing ok',
      fixture: { root: fixtureDir },
      check: 'node -e "require(\'fs\').readFileSync(\'answer.txt\',\'utf8\').includes(\'ok\') || process.exit(1)"',
      trials: 2,
      permissions: { shell: { enabled: true, allow: ['node'] } },
    }]

    const llm: LLMAdapter = {
      async complete(messages, toolDefs) {
        const last = messages.at(-1)
        if (last?.role === 'user') {
          const call = toolDefs.find(tool => tool.schema.name === 'write_file')
          if (call) {
            return {
              finishReason: 'tool_calls',
              toolCalls: [{
                id: 'call-1',
                name: 'write_file',
                arguments: { path: 'answer.txt', content: 'ok' },
              }],
            }
          }
        }
        return { finishReason: 'stop', content: 'done' }
      },
    }

    const ctx = await setup(outputDir)
    try {
      const run = await ctx.service.run({
        candidate: { name: 'coding-test', plugin: () => {} },
        tasks,
        strategyNames: ['check'],
        coding: {
          llm,
          agent: { maxTurns: 2, maxSteps: 4 },
          coding: { skills: false, planTools: false, mcp: false },
        },
      } satisfies EvalRunOptions)
      expect(run.trialSummaries?.[0]?.passRate).toBe(1)
      expect(run.trialSummaries?.[0]?.passed).toBe(2)
      const traceFile = join(outputDir, run.id, 'traces', 'write-answer-1.jsonl')
      expect(await readFile(traceFile, 'utf8')).toContain('tool/result')
    } finally {
      await ctx.dispose()
    }
  })

  it('records a failing check as failed verdict', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tnega-coding-eval-'))
    dirs.push(dir)
    const outputDir = join(dir, 'runs')
    const tasks: Task[] = [{
      id: 'never-writes',
      inputText: 'do nothing',
      check: 'node -e "require(\'fs\').existsSync(\'answer.txt\') || process.exit(1)"',
      trials: 1,
      permissions: { shell: { enabled: true, allow: ['node'] } },
    }]
    const llm: LLMAdapter = {
      async complete() {
        return { finishReason: 'stop', content: 'ok' }
      },
    }
    const ctx = await setup(outputDir)
    try {
      const run = await ctx.service.run({
        candidate: { name: 'coding-test', plugin: () => {} },
        tasks,
        strategyNames: ['check'],
        coding: {
          llm,
          agent: { maxTurns: 1, maxSteps: 2 },
          coding: { skills: false, planTools: false, mcp: false },
        },
      } satisfies EvalRunOptions)
      expect(run.trialSummaries?.[0]?.passRate).toBe(0)
      expect(run.trialSummaries?.[0]?.passed).toBe(0)
    } finally {
      await ctx.dispose()
    }
  })
})
