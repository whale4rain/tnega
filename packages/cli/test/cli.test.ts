import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

import {
  CliError,
  effectiveApiKey,
  main,
  resolveLlmEnv,
  runAgentCommand,
} from '../src/index.js'
import { defaultRunSessionFile } from '../src/home-paths.js'

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
describe('agent run command', () => {
  it('resolves the API key from environment variables without accepting code-level keys', () => {
    expect(resolveLlmEnv({ TNEGA_API_KEY: 'tnega' })).toEqual({ apiKey: 'tnega' })
    expect(resolveLlmEnv({
      TNEGA_API_KEY: 'tnega',
      OPENCODE_GO_API_KEY: 'legacy',
    })).toEqual({ apiKey: 'tnega' })
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

  it('keeps an explicit Anthropic config key ahead of unrelated provider keys', () => {
    expect(effectiveApiKey(
      { apiKey: 'anthropic-key', protocol: 'anthropic' },
      { DEEPSEEK_API_KEY: 'deepseek-key' },
    )).toBe('anthropic-key')
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
    expect(result.sessionFile).toBe(defaultRunSessionFile(dir, 10))
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

  it('starts a new default session instead of reading a legacy run log', async () => {
    const dir = await tempDir('tnega-cli-agent-legacy-session-')
    const sessionDir = join(dir, '.tnega')
    const legacyFile = join(sessionDir, 'run.jsonl')
    const legacy = JSON.stringify({
      id: 'legacy',
      seq: 1,
      ts: 1,
      type: 'message',
      payload: { role: 'user', content: 'old input' },
    })
    await mkdir(sessionDir, { recursive: true })
    await writeFile(legacyFile, `${legacy}\n`, 'utf8')
    vi.stubEnv('OPENCODE_GO_API_KEY', 'test-key')
    vi.stubGlobal('fetch', vi.fn(async () => openaiResponse('new answer')))

    const result = await runAgentCommand({
      prompt: 'new input',
      cwd: dir,
      configFile: join(dir, 'missing-config.json'),
      maxTokens: 16,
    })

    expect(result.sessionFile).toBe(defaultRunSessionFile(dir, 10))
    expect(await readFile(legacyFile, 'utf8')).toBe(`${legacy}\n`)
    expect(await readFile(result.sessionFile, 'utf8')).toContain('"formatVersion":10')
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
    vi.stubEnv('TNEGA_API_KEY', '')
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
    vi.stubEnv('TNEGA_API_KEY', '')
    vi.stubEnv('OPENCODE_GO_API_KEY', '')
    vi.stubEnv('OPENAI_API_KEY', '')
    vi.stubEnv('DEEPSEEK_API_KEY', '')
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
    vi.stubEnv('TNEGA_API_KEY', '')
    vi.stubEnv('OPENCODE_GO_API_KEY', '')
    vi.stubEnv('OPENAI_API_KEY', '')
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const dir = await tempDir('tnega-cli-agent-anthropic-protocol-')
    const configFile = join(dir, 'config.json')
    await writeFile(configFile, JSON.stringify({
      apiKey: 'sk-ant-custom',
      model: 'my-anthropic-model',
      baseUrl: 'https://anthropic.example.com/v1',
      protocol: 'anthropic',
      apiKeyHeader: 'api-key',
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
    expect(headers['api-key']).toBe('sk-ant-custom')
    expect(headers['x-api-key']).toBeUndefined()
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as { model: string }
    expect(body.model).toBe('my-anthropic-model')
  })

  it('loads run settings from a profile file below explicit flags', async () => {
    const dir = await tempDir('tnega-cli-agent-profile-')
    const profileFile = join(dir, 'profile.json')
    await writeFile(profileFile, JSON.stringify({
      name: 'run-profile',
      bundles: [],
      options: {
        model: 'profile-model',
        baseUrl: 'https://profile.example.com/v1',
        maxTurns: 2,
        maxSteps: 4,
        temperature: 0.2,
      },
    }), 'utf8')
    vi.stubEnv('OPENCODE_GO_API_KEY', 'test-key')
    const fetchMock = vi.fn(async () => openaiResponse('profile says hi')) as FetchMock
    vi.stubGlobal('fetch', fetchMock)

    const result = await runAgentCommand({
      prompt: 'say hi',
      cwd: dir,
      profile: profileFile,
      maxTurns: 1,
    })

    expect(result.run.output).toBe('profile says hi')
    const call = fetchMock.mock.calls[0]!
    expect(String(call[0])).toBe('https://profile.example.com/v1/chat/completions')
    const body = JSON.parse(String(call[1]!.body)) as {
      model: string
      temperature: number
    }
    expect(body.model).toBe('profile-model')
    expect(body.temperature).toBe(0.2)
    expect(result.run.steps).toHaveLength(1)
  })

  it('wires a profile through main run', async () => {
    const dir = await tempDir('tnega-cli-agent-profile-main-')
    const profileFile = join(dir, 'profile.json')
    await writeFile(profileFile, JSON.stringify({
      name: 'main-profile',
      options: {
        model: 'profile-model',
        baseUrl: 'https://profile.example.com/v1',
        maxTokens: 8,
      },
    }), 'utf8')
    vi.stubEnv('OPENCODE_GO_API_KEY', 'test-key')
    vi.stubGlobal('fetch', vi.fn(async () => openaiResponse('profile main')))
    const output = captureStdout()

    const code = await main([
      'run',
      '--profile',
      profileFile,
      '--cwd',
      dir,
      'profile prompt',
    ])

    expect(code).toBe(0)
    expect(output()).toContain('profile main')
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


describe('CLI errors', () => {
  it('returns error code for unknown commands, including the removed eval and evolve', async () => {
    const output = captureStdout()
    expect(await main(['nope'])).toBe(2)
    expect(output()).toContain('unknown command')
    expect(await main(['eval', 'run', 'tasks.yml'])).toBe(2)
    expect(await main(['evolve', 'run', 'tasks.yml'])).toBe(2)
    expect(output()).toContain('unknown command: eval')
  })
})
