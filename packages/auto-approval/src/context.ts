import type { ModelMessage } from '@tnega/session'
import type { ApprovalEvidence } from '@tnega/approval-review'

export const REVIEW_CONTEXT_CHARS = 24_000
export const REVIEW_ACTION_CHARS = 16_000

export function buildReviewContext(messages: readonly ModelMessage[]): { evidence: ApprovalEvidence[]; contextTruncated: boolean } {
  const candidates: ApprovalEvidence[] = []
  for (const message of messages) {
    if (message.role === 'user' && message.content.trim()) {
      candidates.push({ source: message.name ? 'agent' : 'human', content: message.content })
    }
    for (const call of message.role === 'assistant' ? message.tool_calls ?? [] : []) {
      candidates.push({ source: 'fact', content: JSON.stringify({ tool: call.name, input: call.arguments }) })
    }
  }
  const kept: ApprovalEvidence[] = []
  let used = 2
  let contextTruncated = false
  // Whole records only: partial authorization or partial commands are never presented as evidence.
  for (const item of [...candidates].reverse()) {
    const size = JSON.stringify(item).length + 1
    if (used + size > REVIEW_CONTEXT_CHARS) { contextTruncated = true; continue }
    kept.unshift(item)
    used += size
  }
  return { evidence: kept, contextTruncated }
}
