import { Context } from '@tnega/core'
import { expect, it } from 'vitest'
import { approvalOpenAI, OpenAIApprovalReviewer } from '../src/index.js'

const request = { workspace: '/work', action: { tool: 'shell', input: {}, schema: {} }, evidence: [], contextTruncated: false }
function result(text = '{"decision":"allow","risk":"low","reason":"Bounded test"}') {
  return { status: 'completed', model: 'gpt-6.1-sol', output: [{ type: 'message', status: 'completed', content: [{ type: 'output_text', text }] }] }
}
it('missing or whitespace credentials never send a request', async () => {
  let calls = 0
  for (const apiKey of ['', '  ']) {
    const reviewer = new OpenAIApprovalReviewer(new Context(), { apiKey, fetch: async () => { calls++; return Response.json(result()) } })
    expect((await reviewer.review(request)).decision).toBe('ask')
  }
  expect(calls).toBe(0)
})
it('requests independent strict Responses review without tools or storage', async () => {
  const reviewer = new OpenAIApprovalReviewer(new Context(), { apiKey: 'test', fetch: async (url, init) => {
    expect(url).toBe('https://api.openai.com/v1/responses')
    const body = JSON.parse(String(init?.body))
    expect(body).toMatchObject({ model: 'gpt-6.1-sol', store: false, tools: [], reasoning: { effort: 'low' }, text: { format: { type: 'json_schema', strict: true } } })
    expect(body.max_output_tokens).toBeGreaterThanOrEqual(2048)
    return Response.json(result())
  } })
  expect(await reviewer.review(request)).toMatchObject({ decision: 'allow', provider: 'openai' })
})
it.each([{}, { ...result(), status: 'incomplete' }, { ...result(), output: [{ type: 'message', status: 'completed', content: [{ type: 'refusal', refusal: 'no' }] }] }, result('invalid'), result('{"decision":"allow","risk":"high","reason":"bad"}')])('asks on invalid or incomplete Responses output', async value => {
  const reviewer = new OpenAIApprovalReviewer(new Context(), { apiKey: 'test', fetch: async () => Response.json(value) })
  expect((await reviewer.review(request)).decision).toBe('ask')
})
it('asks on failed HTTP and bounded timeout', async () => {
  const failed = new OpenAIApprovalReviewer(new Context(), { apiKey: 'test', fetch: async () => new Response('', { status: 401 }) })
  expect((await failed.review(request)).decision).toBe('ask')
  const hanging = new OpenAIApprovalReviewer(new Context(), { apiKey: 'test', timeoutMs: 5, fetch: () => new Promise(() => {}) })
  expect((await hanging.review(request)).decision).toBe('ask')
})
it('disposal cancels review and removes service', async () => {
  const ctx = new Context()
  const fiber = ctx.plugin(approvalOpenAI, { apiKey: 'test', fetch: () => new Promise<Response>(() => {}) })
  await fiber
  const pending = ctx.approvalReviewer.review(request)
  await fiber.dispose()
  expect((await pending).decision).toBe('ask')
  expect(ctx.get('approvalReviewer')).toBeUndefined()
})
it('omitted history preserves the reviewer decision while cancellation cannot allow', async () => {
  const reviewer = new OpenAIApprovalReviewer(new Context(), { apiKey: 'test', fetch: async () => Response.json(result()) })
  expect((await reviewer.review({ ...request, contextTruncated: true })).decision).toBe('allow')
  expect((await reviewer.review({ ...request, signal: AbortSignal.abort() })).decision).toBe('ask')
})
