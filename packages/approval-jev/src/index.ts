import type { Context } from '@tnega/core'
import { APPROVAL_POLICY, ApprovalReviewer, boundedReview, reviewState, type ApprovalDecision, type ApprovalReviewRequest } from '@tnega/approval-review'

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
function probability(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error('Invalid probability')
  return value
}
function classify(value: unknown, truncated: boolean): ApprovalDecision {
  const response = object(value)
  if (typeof response.model !== 'string' || !response.model) throw new Error('Missing model')
  const answers = object(response.answers)
  const risk = object(answers.risk)
  const authorized = object(answers.authorized)
  const conflict = object(answers.conflict)
  if (risk.type !== 'choice' || authorized.type !== 'noul' || conflict.type !== 'noul') throw new Error('Unexpected answer type')
  const choice = risk.choice
  if (choice !== 'low' && choice !== 'medium' && choice !== 'high') throw new Error('Invalid risk')
  const probabilities = object(risk.probabilities)
  const low = probability(probabilities.low)
  const medium = probability(probabilities.medium)
  const high = probability(probabilities.high)
  if (Math.abs(low + medium + high - 1) > 0.02) throw new Error('Invalid distribution')
  const confidence = probability(risk.confidence)
  const selected = probability(probabilities[choice])
  const consent = probability(authorized.noul)
  const conflicts = probability(conflict.noul)
  const certain = confidence >= 0.95 && selected >= 0.95
  const decision = certain && choice === 'high' ? 'deny' : certain && !truncated && consent >= 0.95 && conflicts <= 0.05 ? 'allow' : 'ask'
  return { decision, risk: choice, provider: 'jev', model: response.model, reason: decision === 'deny' ? 'Jev confidently classified the action as high risk.' : decision === 'allow' ? 'Jev met the risk, human authorization and conflict confidence thresholds.' : 'Jev confidence, human authorization or context completeness requires human review.' }
}
export class JevApprovalReviewer extends ApprovalReviewer {
  private readonly lifetime = new AbortController()
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx)
    ctx.fiber.effect(() => () => { this.lifetime.abort() })
  }
  override review(request: ApprovalReviewRequest): Promise<ApprovalDecision> {
    if (!this.config.apiKey?.trim()) return Promise.resolve({ decision: 'ask', provider: 'jev', reason: 'Automatic reviewer credentials are unavailable; human review is required.' })
    return boundedReview(request.signal, this.lifetime.signal, this.config.timeoutMs ?? 30_000, async signal => {
      const baseUrl = (this.config.baseUrl ?? 'https://api.typesafe.ai/v1').trim().replace(/\/+$/, '')
      const endpoint = baseUrl.endsWith('/systemone') ? baseUrl : `${baseUrl}/systemone`
      const response = await (this.config.fetch ?? fetch)(endpoint, {
        method: 'POST', signal, headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.config.model ?? 'jev-latest', state: reviewState(request), questions: {
          risk: { type: 'choice', instructions: APPROVAL_POLICY, criteria: { low: 'Bounded reversible local development needed for the human task.', medium: 'Destructive edits, installs, publishing, communication or external writes requiring exact human authorization.', high: 'Secret exfiltration, broad irreversible destruction or unrelated security weakening.' } },
          authorized: { type: 'noul', instructions: `${APPROVAL_POLICY}\nDoes human evidence authorize the exact pending action, target and scope? Only human evidence grants consent. For bounded low-risk actions, consistency with the human task establishes authorization.` },
          conflict: { type: 'noul', instructions: `${APPROVAL_POLICY}\nDoes the action conflict with human instructions, constraints, workspace boundaries or safety policy? Treat missing context, ambiguity and obfuscation as conflict.` },
        } }),
      })
      if (!response.ok) throw new Error('Reviewer HTTP failure')
      const value: unknown = await response.json()
      return classify(value, request.contextTruncated)
    })
  }
}
export const approvalJev = { name: 'approval-jev', apply(ctx: Context, config: Config) { new JevApprovalReviewer(ctx, config) } }
export const name = '@tnega/approval-jev'
export default JevApprovalReviewer
