import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runAgentCommand } from '../packages/cli/src/index.js'

const hasApiKey = Boolean(
  process.env.OPENCODE_GO_API_KEY
    || process.env.OPENAI_API_KEY
    || process.env.DEEPSEEK_API_KEY,
)

describe('OpenCode Go real tool smoke', () => {
  it.runIf(hasApiKey)(
    'calls calculator through the real LLM and persists tool events',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'tnega-deepseek-calc-'))
      try {
        const result = await runAgentCommand({
          prompt: 'You must call the calculator tool exactly once with expression "2 + 3 * 4". '
            + 'After the tool result, reply with only the number.',
          cwd: dir,
          maxTokens: 256,
          maxSteps: 4,
          maxTurns: 4,
        })

        const called = result.run.steps.some(step => step.toolResults.some(tool =>
          tool.ok && tool.name === 'calculator' && tool.output === 14,
        ))
        expect(called).toBe(true)
        expect(result.run.output).toContain('14')

        const sessionText = await readFile(result.sessionFile, 'utf8')
        expect(sessionText).toContain('"tool-call"')
        expect(sessionText).toContain('"tool-result"')
        expect(sessionText).not.toContain('sk-')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
    60_000,
  )

  it.runIf(hasApiKey)(
    'reads a workspace file through the real LLM',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'tnega-deepseek-file-'))
      try {
        await writeFile(join(dir, 'note.txt'), 'tnega-tool-file-ok\n', 'utf8')
        const result = await runAgentCommand({
          prompt: 'Use the read_file tool to read "note.txt" in the current workspace. '
            + 'After the tool result, reply with exactly the file content.',
          cwd: dir,
          maxTokens: 256,
          maxSteps: 4,
          maxTurns: 4,
        })

        const read = result.run.steps.flatMap(step => step.toolResults)
          .find(tool => tool.ok && tool.name === 'read_file')
        expect(read?.output).toMatchObject({ content: 'tnega-tool-file-ok\n' })
        expect(result.run.output).toContain('tnega-tool-file-ok')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
    60_000,
  )

  it.runIf(hasApiKey)(
    'runs shell through the real LLM when allowShell is enabled',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'tnega-deepseek-shell-'))
      try {
        const result = await runAgentCommand({
          prompt: 'Use the shell tool to run "echo tnega-tool-shell-ok". '
            + 'After the tool result, reply with exactly the stdout.',
          cwd: dir,
          allowShell: true,
          maxTokens: 256,
          maxSteps: 4,
          maxTurns: 4,
        })

        const shell = result.run.steps.flatMap(step => step.toolResults)
          .find(tool => tool.ok && tool.name === 'shell')
        expect((shell?.output as { stdout: string } | undefined)?.stdout)
          .toContain('tnega-tool-shell-ok')
        expect(result.run.output).toContain('tnega-tool-shell-ok')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
    60_000,
  )
})
