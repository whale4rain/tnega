import type { Context } from '@tnega/core'
import type { LLMAdapter } from '@tnega/agent'
import { ApprovalReviewer, APPROVAL_POLICY, boundedReview, parseApprovalDecision, reviewState, type ApprovalDecision, type ApprovalReviewRequest } from '@tnega/approval-review'

/**
 * Room for the decision plus the hidden reasoning that thinking models spend
 * first; a smaller budget ends those reviews at `length` and every call falls
 * back to a human (or parent) decision.
 */
export const REVIEW_MAX_TOKENS = 4_096

export interface LlmApprovalConfig {
  adapter: LLMAdapter | ((request: ApprovalReviewRequest) => LLMAdapter | Promise<LLMAdapter>)
  timeoutMs?: number
  model?: string
}

export class LlmApprovalReviewer extends ApprovalReviewer {
  private readonly lifetime = new AbortController()
  constructor(ctx: Context, private readonly config: LlmApprovalConfig) {
    super(ctx)
    ctx.fiber.effect(() => () => { this.lifetime.abort() }, 'approval-llm cancellation')
  }
  async review(request: ApprovalReviewRequest): Promise<ApprovalDecision> {
    return boundedReview(request.signal, this.lifetime.signal, this.config.timeoutMs ?? 20_000, async signal => {
      const adapter = typeof this.config.adapter === 'function' ? await this.config.adapter(request) : this.config.adapter
      // Each reviewed tool call waits on this. Hidden reasoning tripled the
      // median review time and sometimes ran to the token cap; it is skipped
      // where the route can turn it off.
      const result = await adapter.complete([
        { role: 'system', content: `${APPROVAL_POLICY}\nReturn only JSON: {"decision":"allow|deny|ask","risk":"low|medium|high","reason":"brief explanation"}.` },
        { role: 'user', content: JSON.stringify(reviewState(request)) },
      ], [], { signal, maxTokens: REVIEW_MAX_TOKENS, reasoning: 'off' })
      const decision = parseApprovalDecision(result.finishReason === 'stop' ? result.content : undefined)
      return { ...decision, provider: 'llm', ...(this.config.model ? { model: this.config.model } : {}) }
    })
  }
}
