import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { runEvolveCommand } from '../packages/cli/src/index.js'

const hasApiKey = Boolean(
  process.env.OPENCODE_GO_API_KEY
    || process.env.OPENAI_API_KEY
    || process.env.DEEPSEEK_API_KEY,
)

describe('OpenCode Go evolve real smoke', () => {
  it.runIf(hasApiKey)(
    'runs baseline -> LLM proposal -> candidate eval -> decision',
    async () => {
      const artifactDir = process.env.TNEGA_EVOLVE_ARTIFACT_DIR
      const dir = artifactDir
        ? await mkdir(artifactDir, { recursive: true }).then(() => artifactDir)
        : await mkdtemp(join(tmpdir(), 'tnega-evolve-'))
      try {
        const tasksFile = join(dir, 'tasks.yml')
        await writeFile(tasksFile, [
          'outputDir: .tnega/experiments',
          'tasks:',
          '  - id: fixed-reply',
          '    inputText: Reply with exactly: tnega-evolve-ok',
          '    assertion:',
          '      expect: tnega-evolve-ok',
          'evolve:',
          '  maxIterations: 1',
        ].join('\n'), 'utf8')

        const result = await runEvolveCommand({
          tasksFile,
          cwd: dir,
          baseSystem: 'Always answer with exactly: wrong',
          maxIterations: 1,
          maxTurns: 1,
          maxSteps: 2,
          maxTokens: 512,
          cache: false,
        })

        expect(result.prime.kind).toBe('established')
        expect(['accepted', 'rejected', 'aborted', 'no-candidate']).toContain(
          result.result.kind,
        )
        expect(result.logFile).toContain(join(dir, '.tnega', 'experiments', 'log.json'))

        const logText = await readLog(result.logFile)
        const nodes = logText.nodes as Record<string, unknown> | undefined
        expect(nodes && Object.keys(nodes).length).toBe(2)
        expect(logText.baselineId).toBeTruthy()
        expect(JSON.stringify(logText)).not.toContain('apiKey')
        expect(JSON.stringify(logText)).not.toContain('sk-')
      } finally {
        if (!artifactDir) await rm(dir, { recursive: true, force: true })
      }
    },
    120_000,
  )
})

async function readLog(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
}
