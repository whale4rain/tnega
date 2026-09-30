import type { ModelMessage, SessionEvent } from '@tnega/session'
import type { ApprovalEvidence } from '@tnega/approval-review'

export const REVIEW_CONTEXT_CHARS = 24_000
export const REVIEW_ACTION_CHARS = 16_000

function historicalInput(tool: string, input: unknown): unknown {
  if (tool === 'write_file' && input && typeof input === 'object' && 'content' in input && typeof input.content === 'string') {
    const { content, ...fields } = input
    return { ...fields, contentChars: content.length }
  }
  return input
}

export function buildReviewContext(messages: readonly ModelMessage[], events: readonly SessionEvent[] = []): { evidence: ApprovalEvidence[]; contextTruncated: boolean } {
  const candidates: ApprovalEvidence[] = []
  const latestHumanIndex = messages.findLastIndex(message => message.role === 'user' && !message.name && Boolean(message.content.trim()))
  for (const [index, message] of messages.entries()) {
    if (message.role === 'user' && message.content.trim()) {
      candidates.push({ source: message.name ? 'agent' : 'human', content: message.content })
    }
    // History from previous tasks and orchestration source are not execution facts.
    for (const call of index >= latestHumanIndex && message.role === 'assistant' ? message.tool_calls ?? [] : []) {
      if (call.name === 'run_code') continue
      candidates.push({ source: 'fact', content: JSON.stringify({ tool: call.name, input: historicalInput(call.name, call.arguments) }) })
    }
  }
  const latestHuman = messages[latestHumanIndex]
  const boundary = [...events].reverse().find(event => event.type === 'user/message' && event.payload.content === latestHuman?.content)?.seq
  const starts = new Map<string, Record<string, unknown>>()
  for (const event of events) {
    if (boundary === undefined || event.seq <= boundary || event.type !== 'meta') continue
    const payload = event.payload
    if (payload.kind === 'ptc/dispatch-start' && typeof payload.callId === 'string' && typeof payload.name === 'string') {
      starts.set(payload.callId, payload)
    } else if (payload.kind === 'ptc/dispatch' && typeof payload.callId === 'string' && typeof payload.ok === 'boolean') {
      const start = starts.get(payload.callId)
      if (!start) continue
      starts.delete(payload.callId)
      const result = payload.result
      const output = result && typeof result === 'object' && 'output' in result ? result.output : undefined
      const outcome = output && typeof output === 'object' && 'exitCode' in output && typeof output.exitCode === 'number'
        ? { exitCode: output.exitCode } : undefined
      candidates.push({ source: 'fact', content: JSON.stringify({ tool: start.name, input: historicalInput(String(start.name), start.input),
        status: payload.ok ? 'succeeded' : 'failed', ...(outcome ? { outcome } : {}),
      }) })
    }
  }
  const kept = new Set<number>()
  let used = 2
  let contextTruncated = false
  // Reserve human evidence first; bulky tool facts cannot evict the current request.
  for (const human of [true, false]) {
    for (let index = candidates.length - 1; index >= 0; index--) {
      const item = candidates[index]
      if (!item || (item.source === 'human') !== human) continue
      const size = JSON.stringify(item).length + 1
      if (used + size > REVIEW_CONTEXT_CHARS) { contextTruncated = true; continue }
      kept.add(index)
      used += size
    }
  }
  return { evidence: candidates.filter((_, index) => kept.has(index)), contextTruncated }
}
