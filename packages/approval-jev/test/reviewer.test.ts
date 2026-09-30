import { Context } from '@tnega/core'
import { describe, expect, it } from 'vitest'
import { approvalJev, JevApprovalReviewer } from '../src/index.js'

const request = { workspace: '/work', action: { tool: 'shell', input: { command: 'pnpm test' }, schema: {} }, evidence: [{ source: 'human' as const, content: 'Run tests' }], contextTruncated: false }
function answer(risk = 'low', confidence = 0.99, authorized = 0.99, conflict = 0.01) {
  return { model: 'jev-1.13.0', answers: { risk: { type: 'choice', choice: risk, confidence, probabilities: { low: risk === 'low' ? confidence : 0.005, medium: risk === 'medium' ? confidence : 0.005, high: risk === 'high' ? confidence : 0.005 } }, authorized: { type: 'noul', noul: authorized }, conflict: { type: 'noul', noul: conflict } } }
}
describe('Jev approval reviewer', () => {
  it.each(['https://api.typesafe.ai/v1', 'https://api.typesafe.ai/v1/systemone', 'https://api.typesafe.ai/v1/systemone/'])('accepts a base or complete endpoint: %s', async baseUrl => {
    let calledUrl: unknown
    const reviewer = new JevApprovalReviewer(new Context(), { apiKey: 'test', baseUrl, fetch: async url => {
      calledUrl = url
      return Response.json(answer())
    } })
    expect((await reviewer.review(request)).decision).toBe('allow')
    expect(calledUrl).toBe('https://api.typesafe.ai/v1/systemone')
  })
  it('missing or whitespace credentials never send a request', async () => {
    let calls = 0
    for (const apiKey of ['', '  ']) {
      const reviewer = new JevApprovalReviewer(new Context(), { apiKey, fetch: async () => { calls++; return Response.json(answer()) } })
      expect((await reviewer.review(request)).decision).toBe('ask')
    }
    expect(calls).toBe(0)
  })
  it.each([['low', 0.99, 0.99, 0.01, 'allow'], ['medium', 0.99, 0.99, 0.01, 'allow'], ['high', 0.99, 0, 1, 'deny'], ['high', 0.8, 1, 0, 'ask'], ['low', 0.99, 0.7, 0, 'ask'], ['low', 0.99, 1, 0.2, 'ask']])('maps %s scores conservatively', async (risk, confidence, authorized, conflict, decision) => {
    const reviewer = new JevApprovalReviewer(new Context(), { apiKey: 'test', fetch: async () => Response.json(answer(String(risk), Number(confidence), Number(authorized), Number(conflict))) })
    expect((await reviewer.review(request)).decision).toBe(decision)
  })
  it.each([{}, { answers: {} }, answer('invalid'), answer('low', 2)])('asks on malformed output', async value => {
    const reviewer = new JevApprovalReviewer(new Context(), { apiKey: 'test', fetch: async () => Response.json(value) })
    expect((await reviewer.review(request)).decision).toBe('ask')
  })
  it('uses official questions and bearer authorization', async () => {
    const reviewer = new JevApprovalReviewer(new Context(), { apiKey: 'test', fetch: async (url, init) => {
      expect(url).toBe('https://api.typesafe.ai/v1/systemone')
      expect(init?.headers).toEqual({ Authorization: 'Bearer test', 'Content-Type': 'application/json' })
      const body = JSON.parse(String(init?.body))
      expect(body.model).toBe('jev-latest')
      expect(body.questions.risk.type).toBe('choice')
      expect(body.questions.authorized.type).toBe('noul')
      return Response.json(answer())
    } })
    expect((await reviewer.review(request)).decision).toBe('allow')
  })
  it('asks on HTTP failure, timeout and cancellation', async () => {
    const failed = new JevApprovalReviewer(new Context(), { apiKey: 'test', fetch: async () => new Response('', { status: 500 }) })
    expect((await failed.review(request)).decision).toBe('ask')
    const hanging = new JevApprovalReviewer(new Context(), { apiKey: 'test', timeoutMs: 5, fetch: () => new Promise(() => {}) })
    expect((await hanging.review(request)).decision).toBe('ask')
    expect((await failed.review({ ...request, signal: AbortSignal.abort() })).decision).toBe('ask')
  })
  it('disposal cancels review and removes the service', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(approvalJev, { apiKey: 'test', fetch: () => new Promise<Response>(() => {}) })
    await fiber
    const pending = ctx.approvalReviewer.review(request)
    await fiber.dispose()
    expect((await pending).decision).toBe('ask')
    expect(ctx.get('approvalReviewer')).toBeUndefined()
  })
  it('truncated evidence cannot allow', async () => {
    const reviewer = new JevApprovalReviewer(new Context(), { apiKey: 'test', fetch: async () => Response.json(answer()) })
    expect((await reviewer.review({ ...request, contextTruncated: true })).decision).toBe('ask')
  })
  it('requires chosen probability independently of confidence', async () => {
    const value = answer()
    value.answers.risk.probabilities = { low: 0.8, medium: 0.1, high: 0.1 }
    const reviewer = new JevApprovalReviewer(new Context(), { apiKey: 'test', fetch: async () => Response.json(value) })
    expect((await reviewer.review(request)).decision).toBe('ask')
  })
})
