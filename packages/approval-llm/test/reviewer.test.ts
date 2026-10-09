import { describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import type { LLMAdapter } from '@tnega/agent'
import { LlmApprovalReviewer } from '../src/index.js'
import type { ApprovalReviewRequest } from '../../approval-review/src/index.js'

const action: ApprovalReviewRequest = {
  workspace: '/workspace',
  action: { tool: 'shell', input: { command: 'pnpm test' }, schema: { name: 'shell', description: 'Run a command' } },
  evidence: [{ source: 'human', content: 'Run the tests' }],
  contextTruncated: false,
}

describe('LLM approval provider', () => {
  it('omitted history does not override the reviewer decision', async () => {
    const ctx = new Context()
    const adapter: LLMAdapter = { complete: async () => ({ content: '{"decision":"allow","risk":"low","reason":"ok"}', finishReason: 'stop' }) }
    const fiber = await ctx.plugin(LlmApprovalReviewer, { adapter })
    expect((await ctx.approvalReviewer.review({ ...action, contextTruncated: true })).decision).toBe('allow')
    await fiber.dispose()
  })
  it('disposal cancels in-flight review even when adapter ignores abort', async () => {
    const ctx = new Context()
    let signal: AbortSignal | undefined
    const adapter: LLMAdapter = { complete: (_messages, _tools, options) => { signal = options.signal; return new Promise(() => {}) } }
    const fiber = await ctx.plugin(LlmApprovalReviewer, { adapter })
    const pending = ctx.approvalReviewer.review(action)
    await fiber.dispose()
    expect((await pending).decision).toBe('ask')
    expect(signal?.aborted).toBe(true)
    expect(ctx.get('approvalReviewer', false)).toBeUndefined()
  })
  it('reviews exact actions without tools or conversation assistant instructions', async () => {
    const ctx = new Context()
    const adapter: LLMAdapter = { async complete(messages, tools, options) {
      expect(tools).toEqual([])
      expect(options.maxTokens).toBe(4096)
      expect(options.reasoning).toBe('off')
      expect(messages[1]?.content).toContain('pnpm test')
      expect(messages[0]?.content).toContain('untrusted')
      return { content: '{"decision":"allow","risk":"low","reason":"Tests requested"}', finishReason: 'stop' }
    } }
    const fiber = await ctx.plugin(LlmApprovalReviewer, { adapter })
    expect(await ctx.approvalReviewer.review(action)).toMatchObject({ decision: 'allow', risk: 'low' })
    await fiber.dispose()
    expect(ctx.get('approvalReviewer', false)).toBeUndefined()
  })

  it('reads a decision the model fenced or wrapped in prose', async () => {
    const ctx = new Context()
    const adapter: LLMAdapter = { complete: async () => ({ content: 'Decision:\n```json\n{"decision":"allow","risk":"low","reason":"Tests requested"}\n```', finishReason: 'stop' }) }
    const fiber = await ctx.plugin(LlmApprovalReviewer, { adapter })
    expect((await ctx.approvalReviewer.review(action)).decision).toBe('allow')
    await fiber.dispose()
  })

  it.each([
    'yes',
    '{"decision":"allow","risk":"high","reason":"Send secrets"}',
    '{"decision":"allow","risk":"low"}',
  ])('returns ask for malformed or unsafe approval: %s', async content => {
    const ctx = new Context()
    const adapter: LLMAdapter = { complete: async () => ({ content, finishReason: 'stop' }) }
    const fiber = await ctx.plugin(LlmApprovalReviewer, { adapter })
    expect((await ctx.approvalReviewer.review(action)).decision).toBe('ask')
    await fiber.dispose()
  })

  it('falls back on timeout even if adapter ignores abort', async () => {
    const ctx = new Context()
    const adapter: LLMAdapter = { complete: () => new Promise(() => {}) }
    const fiber = await ctx.plugin(LlmApprovalReviewer, { adapter, timeoutMs: 10 })
    expect((await ctx.approvalReviewer.review(action)).decision).toBe('ask')
    await fiber.dispose()
  })

  it('does not approve after cancellation', async () => {
    const ctx = new Context()
    const controller = new AbortController()
    controller.abort()
    const adapter: LLMAdapter = { complete: async () => ({ content: '{"decision":"allow","risk":"low","reason":"ok"}', finishReason: 'stop' }) }
    const fiber = await ctx.plugin(LlmApprovalReviewer, { adapter })
    expect((await ctx.approvalReviewer.review({ ...action, signal: controller.signal })).decision).toBe('ask')
    await fiber.dispose()
  })
})
