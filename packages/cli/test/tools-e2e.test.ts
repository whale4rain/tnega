import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { runAgentCommand } from '../src/index.js'

type FetchMock = Mock<(...args: [unknown, RequestInit]) => Promise<Response>>

interface MockToolCall {
  id: string
  name: string
  arguments: unknown
}

const dirs: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function openaiResponse(
  content: string,
  toolCalls: MockToolCall[] = [],
  finishReason = 'stop',
): Response {
  const message: Record<string, unknown> = { content }
  if (toolCalls.length) {
    message.tool_calls = toolCalls.map(call => ({
      id: call.id,
      type: 'function',
      function: {
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      },
    }))
  }
  return new Response(JSON.stringify({
    choices: [{ message, finish_reason: finishReason }],
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function toolCall(id: string, name: string, args: unknown): MockToolCall {
  return { id, name, arguments: args }
}

function chatFetchMock(handler: (init: RequestInit) => Response): FetchMock {
  return vi.fn(async (url: unknown, init: RequestInit) => {
    if (String(url).endsWith('/chat/completions')) return handler(init)
    return new Response('{"from":"tool"}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as FetchMock
}

describe('tnega run builtin tools via OpenAI compatible endpoint', () => {
  it('executes calculator and persists tool events in the session', async () => {
    const dir = await tempDir('tnega-cli-tools-calc-')
    vi.stubEnv('OPENCODE_GO_API_KEY', 'test-key')
    let calls = 0
    const fetchMock = chatFetchMock(() => {
      calls += 1
      return calls === 1
        ? openaiResponse('', [
          toolCall('call_calc_1', 'calculator', { expression: '2 + 3 * 4' }),
        ], 'tool_calls')
        : openaiResponse('The result is 14.')
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await runAgentCommand({
      prompt: 'use calculator',
      cwd: dir,
      maxTokens: 64,
      maxSteps: 4,
      maxTurns: 4,
    })

    expect(result.run.steps).toHaveLength(2)
    expect(result.run.steps[0]!.toolResults).toHaveLength(1)
    expect(result.run.steps[0]!.toolResults[0]).toMatchObject({
      ok: true,
      name: 'calculator',
      output: 14,
    })
    expect(result.run.finishReason).toBe('stop')

    const sessionText = await readFile(result.sessionFile, 'utf8')
    expect(sessionText).toContain('"tool-call"')
    expect(sessionText).toContain('"tool-result"')
    expect(sessionText).toContain('calculator')
    expect(sessionText).not.toContain('test-key')
  })

  it('blocks read_file paths that escape the workspace', async () => {
    const dir = await tempDir('tnega-cli-tools-sandbox-')
    vi.stubEnv('OPENCODE_GO_API_KEY', 'test-key')
    let calls = 0
    const fetchMock = chatFetchMock(() => {
      calls += 1
      return calls === 1
        ? openaiResponse('', [
          toolCall('call_read_1', 'read_file', { path: '../secret.txt' }),
        ], 'tool_calls')
        : openaiResponse('done')
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await runAgentCommand({
      prompt: 'read ../secret.txt',
      cwd: dir,
      maxTokens: 64,
    })

    const toolResult = result.run.steps[0]!.toolResults[0]!
    expect(toolResult.ok).toBe(false)
    expect(toolResult.error?.message).toContain('escapes the workspace')
  })

  it('executes shell only when allowShell is enabled', async () => {
    const dir = await tempDir('tnega-cli-tools-shell-')
    vi.stubEnv('OPENCODE_GO_API_KEY', 'test-key')
    let calls = 0
    const fetchMock = chatFetchMock(() => {
      calls += 1
      return calls === 1
        ? openaiResponse('', [
          toolCall('call_shell_1', 'shell', { command: 'echo shell-ok' }),
        ], 'tool_calls')
        : openaiResponse('done')
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await runAgentCommand({
      prompt: 'use shell',
      cwd: dir,
      allowShell: true,
      maxTokens: 64,
    })

    const toolResult = result.run.steps[0]!.toolResults[0]!
    expect(toolResult.ok).toBe(true)
    expect((toolResult.output as { stdout: string }).stdout).toContain('shell-ok')
  })

  it('executes http_get only when allowNetwork is enabled', async () => {
    const dir = await tempDir('tnega-cli-tools-network-')
    vi.stubEnv('OPENCODE_GO_API_KEY', 'test-key')
    let calls = 0
    const fetchMock = chatFetchMock(() => {
      calls += 1
      return calls === 1
        ? openaiResponse('', [
          toolCall('call_http_1', 'http_get', {
            url: 'https://example.test/data',
          }),
        ], 'tool_calls')
        : openaiResponse('done')
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await runAgentCommand({
      prompt: 'fetch https://example.test/data',
      cwd: dir,
      allowNetwork: true,
      maxTokens: 64,
    })

    const toolResult = result.run.steps[0]!.toolResults[0]!
    expect(toolResult.ok).toBe(true)
    expect(toolResult.output).toMatchObject({ status: 200, body: '{"from":"tool"}' })
  })
})
