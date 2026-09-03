import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { EvolveStepResult } from '@tnega/evolve'

import {
  CliError,
  compareCommand,
  formatEvolveResult,
  formatCompare,
  formatRun,
  loadTasksFile,
  main,
  parseYaml,
  resolveLlmEnv,
  runAgentCommand,
  runCommand,
  runEvolveCommand,
} from '../src/index.js'
import type { EvalRun } from '../src/index.js'

type FetchMock = Mock<(...args: [unknown, RequestInit]) => Promise<Response>>

const dirs: string[] = []
let stdoutSpy: ReturnType<typeof vi.spyOn> | undefined

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  stdoutSpy?.mockRestore()
  stdoutSpy = undefined
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function captureStdout(): () => string {
  let output = ''
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((
    chunk: string | Uint8Array,
  ) => {
    output += String(chunk)
    return true
  })
  return () => output
}

function openaiResponse(content = 'hi'): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content }, finish_reason: 'stop' }],
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function anthropicResponse(content = 'hi'): Response {
  return new Response(JSON.stringify({
    id: 'msg_1',
    model: 'minimax-m3',
    content: [{ type: 'text', text: content }],
    stop_reason: 'end_turn',
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

async function writeTasks(
  dir: string,
  file: string,
  overrides: Partial<{
    outputDir: string
    inputText: string
    expect: string
    taskId: string
    candidates: string
  }> = {},
): Promise<string> {
  const taskId = overrides.taskId ?? 'echo-good'
  const inputText = overrides.inputText ?? 'good'
  const expected = overrides.expect ?? 'good'
  const candidates = overrides.candidates ?? `
  echo:
    version: "1"
    loop: echo
`
  const text = [
    `outputDir: ${overrides.outputDir ?? '.tnega/runs'}`,
    'tasks:',
    `  - id: ${taskId}`,
    `    inputText: ${inputText}`,
    '    assertion:',
    `      expect: ${expected}`,
    'strategyNames:',
    '  - assert',
    'candidates:',
    candidates,
    'defaultCandidate: echo',
  ].join('\n')
  const target = join(dir, file)
  await writeFile(target, text, 'utf8')
  return target
}

describe('parseYaml and loadTasksFile', () => {
  it('parses tasks, candidates, strategies and assertions', () => {
    const data = parseYaml(`
# eval tasks
outputDir: runs
tasks:
  - id: echo-good
    inputText: good
    assertion:
      expect: good
strategyNames:
  - assert
  - gate
candidates:
  echo:
    version: "1"
    loop: echo
  empty:
    version: "2"
defaultCandidate: echo
`)

    expect(data).toMatchObject({
      outputDir: 'runs',
      tasks: [
        {
          id: 'echo-good',
          inputText: 'good',
          assertion: { expect: 'good' },
        },
      ],
      strategyNames: ['assert', 'gate'],
      candidates: {
        echo: { version: '1', loop: 'echo' },
        empty: { version: '2' },
      },
      defaultCandidate: 'echo',
    })
  })

  it('loads a tasks file from disk and rejects files without tasks', async () => {
    const dir = await tempDir('tnega-cli-load-')
    const tasksFile = await writeTasks(dir, 'tasks.yml')
    const loaded = loadTasksFile(tasksFile)

    expect(loaded.tasks).toHaveLength(1)
    expect(loaded.tasks[0]).toMatchObject({
      id: 'echo-good',
      inputText: 'good',
      assertion: { expect: 'good' },
    })
    expect(loaded.strategyNames).toEqual(['assert'])
    expect(loaded.outputDir).toBe('.tnega/runs')
    expect(loaded.candidates).toMatchObject({
      echo: { version: '1', loop: 'echo' },
    })

    const empty = join(dir, 'empty.yml')
    await writeFile(empty, 'strategyNames:\n  - assert\n', 'utf8')
    expect(() => loadTasksFile(empty)).toThrow(CliError)
  })
})

describe('eval run command', () => {
  it('runs echo candidates, persists the run and reloads it via compare', async () => {
    const dir = await tempDir('tnega-cli-run-')
    const tasksFile = await writeTasks(dir, 'tasks.yml')
    const run = await runCommand({ tasksFile, cwd: dir })

    expect(run.candidate.name).toBe('echo')
    expect(run.candidate.version).toBe('1')
    expect(run.summary.passed).toBe(1)
    expect(run.summary.failed).toBe(0)
    expect(run.summary.score).toBe(1)
    expect(run.verdicts.map(verdict => verdict.taskId)).toEqual(['echo-good'])

    const runFile = join(dir, '.tnega', 'runs', `${run.id}.json`)
    const saved = JSON.parse(await readFile(runFile, 'utf8')) as EvalRun
    expect(saved.id).toBe(run.id)
    expect(saved.verdicts).toEqual(run.verdicts)

    const result = await compareCommand({
      base: run.id,
      head: run.id,
      outputDir: join(dir, '.tnega', 'runs'),
      cwd: dir,
    })
    expect(result.summary.delta).toBe(0)
    expect(result.taskResults[0]!.changed).toBe(false)
  })

  it('reuses cache and respects --no-cache', async () => {
    const dir = await tempDir('tnega-cli-cache-')
    const tasksFile = await writeTasks(dir, 'tasks.yml')

    const first = await runCommand({ tasksFile, cwd: dir })
    const second = await runCommand({ tasksFile, cwd: dir })
    const uncached = await runCommand({ tasksFile, cwd: dir, cache: false })

    expect(first.cacheHits).toBe(0)
    expect(second.cacheHits).toBe(1)
    expect(uncached.cacheHits).toBe(0)
  })

  it('reports a failed run through main with a nonzero exit code', async () => {
    const dir = await tempDir('tnega-cli-main-fail-')
    const tasksFile = await writeTasks(dir, 'tasks.yml', {
      inputText: 'bad',
      expect: 'good',
    })
    const output = captureStdout()
    const code = await main([
      'eval',
      'run',
      tasksFile,
      '--candidate',
      'echo',
      '--no-cache',
      '--cwd',
      dir,
    ])

    expect(code).toBe(1)
    expect(output()).toContain('score 0.000')
    expect(output()).toContain('(0 passed, 1 failed')
  })
})

describe('eval compare command', () => {
  it('reports improvements, regressions and delta through main', async () => {
    const dir = await tempDir('tnega-cli-compare-')
    const baseFile = await writeTasks(dir, 'base.yml', {
      taskId: 'echo-task',
      inputText: 'bad',
      expect: 'good',
    })
    const headFile = await writeTasks(dir, 'head.yml', {
      taskId: 'echo-task',
      inputText: 'good',
      expect: 'good',
    })
    const base = await runCommand({ tasksFile: baseFile, cwd: dir })
    const head = await runCommand({ tasksFile: headFile, cwd: dir })

    const output = captureStdout()
    const improved = await main(['eval', 'compare', base.id, head.id, '--cwd', dir])
    expect(improved).toBe(0)
    expect(output()).toContain(`base ${base.id}: 0.000`)
    expect(output()).toContain(`head ${head.id}: 1.000`)
    expect(output()).toContain('delta +1.000')
    expect(output()).toContain('improvement echo-task')

    const output2 = captureStdout()
    const regressed = await main(['eval', 'compare', head.id, base.id, '--cwd', dir])
    expect(regressed).toBe(1)
    expect(output2()).toContain('regression echo-task')
  })
})

describe('agent run command', () => {
  it('resolves the API key from environment variables without accepting code-level keys', () => {
    expect(resolveLlmEnv({ OPENCODE_GO_API_KEY: 'a' })).toEqual({ apiKey: 'a' })
    expect(resolveLlmEnv({ OPENAI_API_KEY: 'b' })).toEqual({ apiKey: 'b' })
    expect(resolveLlmEnv({ DEEPSEEK_API_KEY: 'c' })).toEqual({ apiKey: 'c' })
    expect(resolveLlmEnv({
      OPENCODE_GO_BASE_URL: 'https://example.test/v1',
      OPENCODE_GO_MODEL: 'deepseek-v4-pro',
    })).toEqual({
      baseUrl: 'https://example.test/v1',
      model: 'deepseek-v4-pro',
    })
  })

  it('runs an agent against a mocked OpenAI compatible endpoint and never writes the key', async () => {
    const dir = await tempDir('tnega-cli-agent-')
    vi.stubEnv('OPENCODE_GO_API_KEY', 'test-key')
    const fetchMock = vi.fn(async () => openaiResponse('agent says hi')) as FetchMock
    vi.stubGlobal('fetch', fetchMock)

    const result = await runAgentCommand({
      prompt: 'say hi',
      cwd: dir,
      model: 'deepseek-v4-flash',
      maxTokens: 16,
    })

    expect(result.run.output).toBe('agent says hi')
    expect(result.run.finishReason).toBe('stop')
    expect(result.sessionFile).toBe(join(dir, '.tnega', 'run.jsonl'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const init = fetchMock.mock.calls[0]![1]!
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-key')
    const body = JSON.parse(String(init.body)) as { max_tokens: number; model: string }
    expect(body.model).toBe('deepseek-v4-flash')
    expect(body.max_tokens).toBe(16)

    const sessionText = await readFile(result.sessionFile, 'utf8')
    expect(sessionText).toContain('agent says hi')
    expect(sessionText).not.toContain('test-key')
  })

  it('defaults to deepseek-v4-flash through the OpenAI compatible endpoint', async () => {
    const dir = await tempDir('tnega-cli-agent-default-')
    vi.stubEnv('OPENCODE_GO_API_KEY', 'test-key')
    const fetchMock = vi.fn(async () => openaiResponse('default model')) as FetchMock
    vi.stubGlobal('fetch', fetchMock)

    const result = await runAgentCommand({
      prompt: 'say hi',
      cwd: dir,
      configFile: join(dir, 'missing-default-config.json'),
      maxTokens: 16,
    })

    expect(result.run.output).toBe('default model')
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'https://opencode.ai/zen/go/v1/chat/completions',
    )
    const init = fetchMock.mock.calls[0]![1]!
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Bearer test-key',
    )
    const body = JSON.parse(String(init.body)) as { model: string }
    expect(body.model).toBe('deepseek-v4-flash')
  })

  it('rejects a run without an API key', async () => {
    vi.stubEnv('OPENCODE_GO_API_KEY', '')
    vi.stubEnv('OPENAI_API_KEY', '')
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const dir = await tempDir('tnega-cli-agent-nokey-')

    await expect(runAgentCommand({
      prompt: 'hello',
      cwd: dir,
      configFile: join(dir, 'missing-config.json'),
    })).rejects.toThrow(CliError)
  })

  it('reads the API key and model from a config file through the Anthropic adapter', async () => {
    const dir = await tempDir('tnega-cli-agent-config-')
    const configFile = join(dir, 'config.json')
    await writeFile(configFile, JSON.stringify({
      apiKey: 'config-key',
      model: 'minimax-m3',
      baseUrl: 'https://opencode.ai/zen/go/v1',
    }), 'utf8')
    const fetchMock = vi.fn(async () => anthropicResponse('config agent')) as FetchMock
    vi.stubGlobal('fetch', fetchMock)

    const result = await runAgentCommand({
      prompt: 'say hi',
      cwd: dir,
      configFile,
      maxTokens: 16,
    })

    expect(result.run.output).toBe('config agent')
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'https://opencode.ai/zen/go/v1/messages',
    )
    const init = fetchMock.mock.calls[0]![1]!
    const headers = init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('config-key')
    expect(headers.authorization).toBeUndefined()
    const body = JSON.parse(String(init.body)) as { model: string; max_tokens: number }
    expect(body.model).toBe('minimax-m3')
    expect(body.max_tokens).toBe(16)
  })

  it('uses the Anthropic wire protocol when config protocol is anthropic', async () => {
    const dir = await tempDir('tnega-cli-agent-anthropic-protocol-')
    const configFile = join(dir, 'config.json')
    await writeFile(configFile, JSON.stringify({
      apiKey: 'sk-ant-custom',
      model: 'my-anthropic-model',
      baseUrl: 'https://anthropic.example.com/v1',
      protocol: 'anthropic',
    }), 'utf8')
    const fetchMock = vi.fn(async () => anthropicResponse('custom anthropic')) as FetchMock
    vi.stubGlobal('fetch', fetchMock)

    const result = await runAgentCommand({
      prompt: 'hello',
      cwd: dir,
      configFile,
    })

    expect(result.run.output).toBe('custom anthropic')
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'https://anthropic.example.com/v1/messages',
    )
    const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-ant-custom')
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as { model: string }
    expect(body.model).toBe('my-anthropic-model')
  })

  it('retries a transient LLM failure with the configured limits', async () => {
    const dir = await tempDir('tnega-cli-agent-retry-')
    vi.stubEnv('OPENCODE_GO_API_KEY', 'test-key')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 500 }))
      .mockResolvedValueOnce(openaiResponse('after retry')) as FetchMock
    vi.stubGlobal('fetch', fetchMock)

    const result = await runAgentCommand({
      prompt: 'say hi',
      cwd: dir,
      maxRetries: 1,
      retryDelayMs: 1,
    })

    expect(result.run.output).toBe('after retry')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('prints a run through main with flags and a mocked provider', async () => {
    const dir = await tempDir('tnega-cli-agent-main-')
    vi.stubEnv('OPENCODE_GO_API_KEY', 'test-key')
    vi.stubGlobal('fetch', vi.fn(async () => openaiResponse('flagged output')))
    const output = captureStdout()

    const code = await main([
      'run',
      '--max-tokens',
      '8',
      '--timeout-ms',
      '5000',
      '--max-retries',
      '1',
      '--retry-delay-ms',
      '1',
      '--cwd',
      dir,
      'flagged prompt',
    ])

    expect(code).toBe(0)
    expect(output()).toContain('flagged output')
    expect(output()).toContain('finish stop')
    expect(output()).toContain('session ')
    expect(output()).not.toContain('test-key')
  })
})

describe('evolve run command', () => {
  function stepNode(result: EvolveStepResult) {
    return result.kind === 'no-candidate' ? undefined : result.node
  }

  async function writeEvolveTasks(dir: string): Promise<string> {
    const file = join(dir, 'evolve-tasks.yml')
    await writeFile(file, [
      'outputDir: .tnega/runs',
      'tasks:',
      '  - id: t1',
      '    inputText: hello',
      '    assertion:',
      '      expect: hi',
      'strategyNames:',
      '  - assert',
      'evolve:',
      '  maxIterations: 1',
    ].join('\n'), 'utf8')
    return file
  }

  function evolveFetchMock(): { fetchMock: FetchMock } {
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        messages: Array<{ content: string }>
      }
      const text = body.messages.map(message => message.content).join('\n')
      if (text.includes('自进化引擎')) {
        return openaiResponse(JSON.stringify({
          name: 'fix-output',
          system: 'answer hi',
          rationale: 'baseline failed the assert task',
          mutationDescription: 'switch system prompt to answer hi',
        }))
      }
      const system = body.messages[0]?.content ?? ''
      return openaiResponse(system === 'answer hi' ? 'hi' : 'wrong')
    }) as FetchMock
    vi.stubGlobal('fetch', fetchMock)
    return { fetchMock }
  }

  it('runs a full baseline -> propose -> candidate loop against a mocked provider', async () => {
    const dir = await tempDir('tnega-cli-evolve-')
    const tasksFile = await writeEvolveTasks(dir)
    vi.stubEnv('OPENCODE_GO_API_KEY', 'test-key')
    const { fetchMock } = evolveFetchMock()

    const result = await runEvolveCommand({
      tasksFile,
      cwd: dir,
      model: 'deepseek-v4-flash',
      baseSystem: 'baseline system',
      maxTurns: 1,
      maxSteps: 2,
      maxTokens: 32,
    })

    expect(result.prime.kind).toBe('established')
    const prime = stepNode(result.prime)
    expect(prime?.candidate.name).toBe('baseline')
    expect(prime?.run.summary.score).toBe(0)
    expect(result.result.kind).toBe('accepted')
    const finalNode = stepNode(result.result)
    expect(finalNode?.candidate.name).toBe('fix-output')
    expect(finalNode?.status).toBe('accepted')
    expect(finalNode?.decision?.delta).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)

    const logText = await readFile(result.logFile, 'utf8')
    const log = JSON.parse(logText) as {
      baselineId: string
      nodes: Record<string, { candidate: { name: string }; status: string }>
    }
    expect(Object.keys(log.nodes)).toHaveLength(2)
    expect(log.baselineId).toBe(finalNode?.id)
    expect(Object.values(log.nodes).some(node => node.candidate.name === 'fix-output')).toBe(true)
    expect(logText).not.toContain('test-key')

    const runFiles = await readdir(result.runDir)
    expect(runFiles.filter(file => file.endsWith('.json'))).toHaveLength(2)

    const formatted = formatEvolveResult(result)
    expect(formatted).toContain('baseline baseline: score 0.000')
    expect(formatted).toContain('decision accepted')
    expect(formatted).toContain('candidate fix-output')
    expect(formatted).toContain(`log ${result.logFile}`)
  })

  it('rejects a run without an API key', async () => {
    vi.stubEnv('OPENCODE_GO_API_KEY', '')
    vi.stubEnv('OPENAI_API_KEY', '')
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const dir = await tempDir('tnega-cli-evolve-nokey-')
    const tasksFile = await writeEvolveTasks(dir)

    await expect(runEvolveCommand({
      tasksFile,
      cwd: dir,
      configFile: join(dir, 'missing-config.json'),
    })).rejects.toThrow(CliError)
  })

  it('wires evolve run through main with flags', async () => {
    const dir = await tempDir('tnega-cli-evolve-main-')
    const tasksFile = await writeEvolveTasks(dir)
    vi.stubEnv('OPENCODE_GO_API_KEY', 'test-key')
    evolveFetchMock()
    const output = captureStdout()

    const code = await main([
      'evolve',
      'run',
      tasksFile,
      '--cwd',
      dir,
      '--model',
      'deepseek-v4-flash',
      '--iterations',
      '1',
      '--base-system',
      'baseline system',
      '--no-cache',
      '--timeout-ms',
      '5000',
      '--max-retries',
      '1',
      '--retry-delay-ms',
      '1',
    ])

    expect(code).toBe(0)
    expect(output()).toContain('decision accepted')
    expect(output()).toContain('candidate fix-output')
    expect(output()).toContain('log ')
    expect(output()).not.toContain('test-key')
  })
})

describe('CLI errors and formatting', () => {
  it('returns error code for unknown commands and missing tasks files', async () => {
    const output = captureStdout()
    expect(await main(['nope'])).toBe(2)
    expect(output()).toContain('unknown command')
    expect(await main(['eval', 'run'])).toBe(2)
    expect(output()).toContain('eval run requires a tasks file')
  })

  it('formats run and compare output', async () => {
    const dir = await tempDir('tnega-cli-format-')
    const tasksFile = await writeTasks(dir, 'tasks.yml')
    const run = await runCommand({ tasksFile, cwd: dir })
    const result = await compareCommand({
      base: run.id,
      head: run.id,
      outputDir: join(dir, '.tnega', 'runs'),
      cwd: dir,
    })

    expect(formatRun(run)).toContain(`run ${run.id}`)
    expect(formatRun(run)).toContain('candidate echo@1')
    expect(formatCompare(result)).toContain(`base ${run.id}: 1.000`)
    expect(formatCompare(result)).toContain('delta +0.000')
  })
})
