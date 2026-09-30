import { Context } from '@tnega/core'
import { describe, expect, it } from 'vitest'
import { approvalJev, JevApprovalReviewer } from '../src/index.js'

const request = { workspace: '/work', action: { tool: 'shell', input: { command: 'pnpm test' }, schema: {} }, evidence: [{ source: 'human' as const, content: 'Run tests' }], contextTruncated: false }
function answer(risk = 'low', confidence = 0.99, conflict = 0.01) {
  return { model: 'jev-1.13.0', answers: { risk: { type: 'choice', choice: risk, confidence, probabilities: { low: risk === 'low' ? confidence : (1 - confidence) / 2, medium: risk === 'medium' ? confidence : (1 - confidence) / 2, high: risk === 'high' ? confidence : (1 - confidence) / 2 } }, conflict: { type: 'noul', noul: conflict } } }
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
  it.each([['low', 0.99, 0.01, 'allow'], ['medium', 0.99, 0.01, 'allow'], ['high', 0.99, 1, 'deny'], ['high', 0.8, 0, 'ask'], ['low', 0.99, 0.2, 'allow'], ['low', 0.99, 0.3, 'ask'], ['medium', 0.99, 0.05, 'allow'], ['medium', 0.99, 0.2, 'ask'], ['low', 0.8, 0, 'ask']])('maps %s scores by risk tier', async (risk, confidence, conflict, decision) => {
    const reviewer = new JevApprovalReviewer(new Context(), { apiKey: 'test', fetch: async () => Response.json(answer(String(risk), Number(confidence), Number(conflict))) })
    expect((await reviewer.review(request)).decision).toBe(decision)
  })
  it('allows low-risk actions without authorization or task-alignment answers and records scores', async () => {
    const reviewer = new JevApprovalReviewer(new Context(), { apiKey: 'test', fetch: async () => Response.json(answer('low', 0.99, 0.1)) })
    expect((await reviewer.review(request)).scores).toEqual({ riskConfidence: 0.99, riskProbability: 0.99, conflict: 0.1, contextTruncated: false })
    expect((await reviewer.review(request)).decision).toBe('allow')
  })
  it('explains absent human evidence and medium-risk conflict', async () => {
    const missing = new JevApprovalReviewer(new Context(), { apiKey: 'test', fetch: async () => Response.json(answer()) })
    expect(await missing.review({ ...request, evidence: [] })).toMatchObject({ decision: 'ask', reason: expect.stringContaining('No human task') })
    const medium = new JevApprovalReviewer(new Context(), { apiKey: 'test', fetch: async () => Response.json(answer('medium', 0.99, 0.2)) })
    expect(await medium.review(request)).toMatchObject({ decision: 'ask', reason: 'Conflict probability 0.2 exceeds 0.05' })
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
      expect(Object.keys(body.questions).sort()).toEqual(['conflict', 'risk'])
      expect(body.questions.conflict.type).toBe('noul')
      expect(body.questions.conflict.instructions).not.toMatch(/Treat missing context|Ambiguity|Return only JSON|exact.*authoriz/i)
      expect(body.questions.conflict.instructions).toContain('Does the action conflict with human instructions, constraints, workspace boundaries or safety policy?')
      return Response.json(answer())
    } })
    expect((await reviewer.review(request)).decision).toBe('allow')
  })
  it('asks on HTTP failure, timeout and cancellation', async () => {
    const failed = new JevApprovalReviewer(new Context(), { apiKey: 'test', fetch: async () => new Response('', { status: 500 }) })
    expect(await failed.review(request)).toMatchObject({ decision: 'ask', reason: expect.stringContaining('HTTP 500') })
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
  it.each([0.85, 0.86, 0.9])('allows low-risk review with confidence %s despite omitted history', async confidence => {
    const reviewer = new JevApprovalReviewer(new Context(), { apiKey: 'test', fetch: async () => Response.json(answer('low', confidence, 0.14)) })
    expect(await reviewer.review({ ...request, contextTruncated: true })).toMatchObject({ decision: 'allow', scores: { riskConfidence: confidence, contextTruncated: true } })
  })
  it('uses confidence as the threshold and records chosen probability without another gate', async () => {
    const value = answer()
    value.answers.risk.probabilities = { low: 0.8, medium: 0.1, high: 0.1 }
    const reviewer = new JevApprovalReviewer(new Context(), { apiKey: 'test', fetch: async () => Response.json(value) })
    expect(await reviewer.review(request)).toMatchObject({ decision: 'allow', scores: { riskProbability: 0.8 } })
  })
  it.each([['low', 'allow'], ['medium', 'allow'], ['high', 'deny']])('uses the 0.85 confidence boundary for %s risk', async (risk, decision) => {
    const reviewer = new JevApprovalReviewer(new Context(), { apiKey: 'test', fetch: async () => Response.json(answer(risk, 0.85)) })
    expect((await reviewer.review(request)).decision).toBe(decision)
    const uncertain = new JevApprovalReviewer(new Context(), { apiKey: 'test', fetch: async () => Response.json(answer(risk, 0.849)) })
    expect(await uncertain.review(request)).toMatchObject({ decision: 'ask', reason: 'Risk confidence 0.849 is below 0.85' })
  })
})
