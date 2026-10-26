import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { session, type SessionLog } from '@tnega/session'
import { tools } from '@tnega/tools'
import {
  agent,
  isContextOverflowError,
  type AgentContextBudget,
  type AgentLoop,
  type AgentRequestErrorEvent,
  type LLMAdapter,
  type LLMCompletion,
} from '../src/index.js'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

/** What a provider returns when the prompt no longer fits the window. */
function overflowError(detail = '{"error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"}}'): Error {
  return Object.assign(new Error('LLM request failed with status 400'), { status: 400, detail })
}

interface Setup {
  loop: AgentLoop
  calls: () => number
  log: SessionLog
  root: Context
}

async function setup(options: {
  replies: (call: number) => LLMCompletion
  budget?: AgentContextBudget
}): Promise<Setup> {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-overflow-'))
  dirs.push(dir)
  const root = new Context()
  await root.plugin(session, { file: join(dir, 's.jsonl') })
  await root.plugin(tools)
  let calls = 0
  const adapter: LLMAdapter = {
    async complete() {
      calls += 1
      return options.replies(calls)
    },
  }
  await root.plugin(agent, {
    llm: adapter,
    ...(options.budget ? { contextBudget: options.budget } : {}),
  })
  return { loop: root.get('agentLoop') as AgentLoop, calls: () => calls, log: root.get('session'), root }
}

describe('isContextOverflowError', () => {
  it('recognises the messages providers actually send', () => {
    // Anthropic
    expect(isContextOverflowError(overflowError())).toBe(true)
    expect(isContextOverflowError(Object.assign(new Error('400'), {
      status: 400,
      detail: '{"error":{"message":"input length and `max_tokens` exceed context limit"}}',
    }))).toBe(true)
    // OpenAI-compatible
    expect(isContextOverflowError(Object.assign(new Error('400'), {
      status: 400,
      detail: '{"error":{"code":"context_length_exceeded","message":"This model\'s maximum context length is 128000 tokens"}}',
    }))).toBe(true)
    // Nothing to do with the window.
    expect(isContextOverflowError(Object.assign(new Error('401'), { status: 401, detail: 'invalid api key' }))).toBe(false)
    expect(isContextOverflowError(new Error('spawn EPERM'))).toBe(false)
    expect(isContextOverflowError(undefined)).toBe(false)
  })
})

describe('context overflow recovery', () => {
  it('compacts and retries instead of failing the run', async () => {
    const { loop, calls, log, root } = await setup({
      budget: { limit: 100, compactRatio: 0.1, summarize: async () => [{ role: 'system', content: 'summary of earlier work' }] },
      replies: call => {
        // The second request fits: the retry carries the compacted conversation.
        if (call === 1) throw overflowError()
        return { content: 'recovered', finishReason: 'stop' }
      },
    })
    try {
      const result = await loop({ text: 'z'.repeat(400) })
      expect(result.output).toBe('recovered')
      expect(result.finishReason).toBe('stop')
      expect(calls()).toBe(2)
      const events = await log.read()
      // The recovery is durable: it went through the same compaction record.
      expect(events.some(event => event.type === 'compaction/start')).toBe(true)
    } finally {
      await root.fiber.dispose()
    }
  })

  it('leaves an overflow unrecovered when no compaction is configured', async () => {
    const { loop, calls, root } = await setup({
      replies: () => { throw overflowError() },
    })
    try {
      // Without a budget there is nothing to compact, so the failure stands.
      await expect(loop({ text: 'go' })).rejects.toThrow(/status 400/)
      expect(calls()).toBe(1)
    } finally {
      await root.fiber.dispose()
    }
  })

  it('does not treat an unrelated failure as an overflow', async () => {
    const { loop, calls, log, root } = await setup({
      budget: { limit: 100, compactRatio: 0.1, summarize: async () => [{ role: 'system', content: 'unused' }] },
      replies: () => { throw Object.assign(new Error('LLM request failed with status 401'), { status: 401, detail: 'invalid api key' }) },
    })
    try {
      await expect(loop({ text: 'go' })).rejects.toThrow(/status 401/)
      expect(calls()).toBe(1)
      // No compaction ran either: an auth failure is not a size problem.
      expect((await log.read()).some(event => event.type === 'compaction/start')).toBe(false)
    } finally {
      await root.fiber.dispose()
    }
  })

  it('gives way to a plugin that answers first', async () => {
    const { loop, calls, log, root } = await setup({
      budget: { limit: 100, compactRatio: 0.1, summarize: async () => [{ role: 'system', content: 'unused' }] },
      replies: call => call === 1 ? (() => { throw overflowError() })() : { content: 'plugin path', finishReason: 'stop' },
    })
    const seen: AgentRequestErrorEvent[] = []
    root.on('agent/request-error', async (payload: AgentRequestErrorEvent) => {
      seen.push(payload)
      // A plugin that decides on its own: no compaction of the builtin kind.
      return { kind: 'retry' }
    })
    try {
      const result = await loop({ text: 'go' })
      expect(result.output).toBe('plugin path')
      expect(seen).toHaveLength(1)
      // The plugin's retry carried no replacement: it went through unchanged.
      expect(calls()).toBe(2)
      expect((await log.read()).some(event => event.type === 'compaction/start')).toBe(false)
    } finally {
      await root.fiber.dispose()
    }
  })

  it('gives up rather than loop when compaction cannot shrink anything', async () => {
    const { loop, calls, root } = await setup({
      budget: { limit: 1, compactRatio: 0.1 },
      replies: () => { throw overflowError() },
    })
    try {
      // Recovery runs once: a second overflow is a real failure, not a spin.
      await expect(loop({ text: 'go' })).rejects.toThrow(/status 400/)
      expect(calls()).toBe(2)
    } finally {
      await root.fiber.dispose()
    }
  })
})
