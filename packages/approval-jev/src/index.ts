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
function classify(value: unknown, request: ApprovalReviewRequest): ApprovalDecision {
  const response = object(value)
  if (typeof response.model !== 'string' || !response.model) throw new Error('Missing model')
  const answers = object(response.answers)
  const risk = object(answers.risk)
  const conflict = object(answers.conflict)
  if (risk.type !== 'choice' || conflict.type !== 'noul') throw new Error('Unexpected answer type')
  const choice = risk.choice
  if (choice !== 'low' && choice !== 'medium' && choice !== 'high') throw new Error('Invalid risk')
  const probabilities = object(risk.probabilities)
  const low = probability(probabilities.low)
  const medium = probability(probabilities.medium)
  const high = probability(probabilities.high)
  if (Math.abs(low + medium + high - 1) > 0.02) throw new Error('Invalid distribution')
  const confidence = probability(risk.confidence)
  const selected = probability(probabilities[choice])
  const conflicts = probability(conflict.noul)
  const scores = { riskConfidence: confidence, riskProbability: selected, conflict: conflicts, contextTruncated: request.contextTruncated }
  const certain = confidence >= 0.95 && selected >= 0.95
  const result = { risk: choice, provider: 'jev', model: response.model, scores } satisfies Omit<ApprovalDecision, 'decision' | 'reason'>
  if (choice === 'high' && certain) return { ...result, decision: 'deny', reason: 'Jev confidently classified the action as high risk.' }
  const unmet: string[] = []
  if (confidence < 0.95) unmet.push(`Risk confidence ${confidence} is below 0.95`)
  if (selected < 0.95) unmet.push(`Risk probability ${selected} is below 0.95`)
  if (choice === 'high') return { ...result, decision: 'ask', reason: unmet.join('; ') }
  if (request.contextTruncated) unmet.push('Context is truncated')
  if (!request.evidence.some(item => item.source === 'human' && item.content.trim())) unmet.push('No human task is available')
  const conflictThreshold = choice === 'low' ? 0.2 : 0.05
  if (conflicts > conflictThreshold) unmet.push(`Conflict probability ${conflicts} exceeds ${conflictThreshold}`)
  return { ...result, decision: unmet.length ? 'ask' : 'allow', reason: unmet.length ? unmet.join('; ') : 'Action meets risk confidence and conflict thresholds.' }
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
          risk: { type: 'choice', instructions: APPROVAL_POLICY, criteria: { low: 'Bounded reversible local development needed for the human task.', medium: 'Destructive edits, installs, publishing, communication or external writes.', high: 'Secret exfiltration, broad irreversible destruction or unrelated security weakening.' } },
          conflict: { type: 'noul', instructions: `${APPROVAL_POLICY}\nDoes the action conflict with human instructions, constraints, workspace boundaries or safety policy?` },
        } }),
      })
      if (!response.ok) return { decision: 'ask', provider: 'jev', reason: `Jev request failed with HTTP ${response.status}; human review is required.` }
      try {
        const value: unknown = await response.json()
        return classify(value, request)
      } catch {
        return { decision: 'ask', provider: 'jev', reason: 'Jev returned invalid review scores or answer schema; human review is required.' }
      }
    })
  }
}
export const approvalJev = { name: 'approval-jev', apply(ctx: Context, config: Config) { new JevApprovalReviewer(ctx, config) } }
export const name = '@tnega/approval-jev'
export default JevApprovalReviewer
