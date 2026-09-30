import type { Context } from '@tnega/core'
import { APPROVAL_POLICY, ApprovalReviewer, boundedReview, parseApprovalDecision, reviewState, type ApprovalDecision, type ApprovalReviewRequest } from '@tnega/approval-review'

export interface Config {
  apiKey: string
  model?: string
  baseUrl?: string
  timeoutMs?: number
  fetch?: typeof fetch
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object')
  return Object.fromEntries(Object.entries(value))
}
function parseResponse(value: unknown): ApprovalDecision {
  const response = object(value)
  if (response.status !== 'completed' || typeof response.model !== 'string' || !Array.isArray(response.output)) throw new Error('Incomplete review')
  const texts: string[] = []
  for (const value of response.output) {
    const item = object(value)
    if (item.type === 'reasoning') continue
    if (item.type !== 'message' || item.status !== 'completed' || !Array.isArray(item.content)) throw new Error('Unexpected review output')
    for (const value of item.content) {
      const part = object(value)
      if (part.type !== 'output_text' || typeof part.text !== 'string') throw new Error('Refused or malformed review')
      texts.push(part.text)
    }
  }
  if (texts.length !== 1) throw new Error('Ambiguous review output')
  return { ...parseApprovalDecision(texts[0]), provider: 'openai', model: response.model }
}
export class OpenAIApprovalReviewer extends ApprovalReviewer {
  private readonly lifetime = new AbortController()
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx)
    ctx.fiber.effect(() => () => { this.lifetime.abort() })
  }
  override review(request: ApprovalReviewRequest): Promise<ApprovalDecision> {
    if (!this.config.apiKey?.trim()) return Promise.resolve({ decision: 'ask', provider: 'openai', reason: 'Automatic reviewer credentials are unavailable; human review is required.' })
    return boundedReview(request.signal, this.lifetime.signal, this.config.timeoutMs ?? 30_000, async signal => {
      const response = await (this.config.fetch ?? fetch)(`${(this.config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')}/responses`, {
        method: 'POST', signal, headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.config.model ?? 'gpt-6.1-sol', store: false, tools: [], reasoning: { effort: 'low' }, max_output_tokens: 2048,
          input: [{ role: 'system', content: APPROVAL_POLICY }, { role: 'user', content: JSON.stringify(reviewState(request)) }],
          text: { format: { type: 'json_schema', name: 'approval_decision', strict: true, schema: { type: 'object', additionalProperties: false, required: ['decision', 'risk', 'reason'], properties: { decision: { type: 'string', enum: ['allow', 'deny', 'ask'] }, risk: { type: 'string', enum: ['low', 'medium', 'high'] }, reason: { type: 'string' } } } } },
        }),
      })
      if (!response.ok) throw new Error('Reviewer HTTP failure')
      const value: unknown = await response.json()
      const decision = parseResponse(value)
      return decision
    })
  }
}
export const approvalOpenAI = { name: 'approval-openai', apply(ctx: Context, config: Config) { new OpenAIApprovalReviewer(ctx, config) } }
export const name = '@tnega/approval-openai'
export default OpenAIApprovalReviewer
