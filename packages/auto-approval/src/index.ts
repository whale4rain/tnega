import type { Context } from '@tnega/core'
import type { SessionLog, ModelMessage } from '@tnega/session'
import type { ToolRequest } from '@tnega/tools'
import { boundedReview, type ApprovalDecision, type ApprovalMode } from '@tnega/approval-review'
import { buildReviewContext, REVIEW_ACTION_CHARS } from './context.js'
export { buildReviewContext } from './context.js'

export interface AutoApprovalRequest { tool: ToolRequest; decision?: ApprovalDecision }
export interface AutoApprovalConfig {
  workspace: string
  timeoutMs?: number
  mode: (agentId?: string) => ApprovalMode | Promise<ApprovalMode>
  session: (agentId: string | undefined) => SessionLog | undefined
  constraints?: () => Promise<string>
  evidenceMessages?: (messages: ModelMessage[]) => Promise<ModelMessage[]>
}

export const autoApproval = {
  name: 'auto-approval',
  inject: ['approvalReviewer'],
  apply(ctx: Context, config: AutoApprovalConfig): void {
    const lifetime = new AbortController()
    ctx.fiber.effect(() => () => { lifetime.abort() }, 'auto-approval cancellation')
    ctx.on('approval/review', async (event: AutoApprovalRequest) => {
      const request = event.tool
      if (await config.mode(request.options.agentId) !== 'auto') return
      const session = config.session(request.options.agentId)
      if (!session) { event.decision = { decision: 'ask', reason: 'Requesting Agent context is unavailable.' }; return }
      const action = { tool: request.name, input: request.input, schema: request.tool.schema }
      if (JSON.stringify(action).length > REVIEW_ACTION_CHARS) {
        event.decision = { decision: 'ask', reason: 'Action exceeds automatic review budget; human review is required.' }
      } else {
        const derived = await session.deriveMessages()
        const messages = config.evidenceMessages ? await config.evidenceMessages(derived) : derived
        const context = buildReviewContext(messages)
        const latestHuman = [...messages].reverse().find(message => message.role === 'user' && !message.name)
        const constraints = await config.constraints?.() ?? ''
        if ((latestHuman && !context.evidence.some(item => item.source === 'human' && item.content === latestHuman.content)) || constraints.length > 8_000) {
          event.decision = { decision: 'ask', reason: 'Current request or project constraints exceed automatic review budget.' }
        } else {
          if (constraints) context.evidence.push({ source: 'constraint', content: constraints })
          event.decision = await boundedReview(request.options.signal, lifetime.signal, config.timeoutMs ?? 30_000, signal => ctx.approvalReviewer.review({
            workspace: config.workspace, action, ...context,
            signal,
          }))
        }
      }
      if (lifetime.signal.aborted || request.options.signal?.aborted || await config.mode(request.options.agentId) !== 'auto') {
        event.decision = { decision: 'ask', reason: 'Automatic review cancelled or approval mode changed.' }
      }
      await session.append('meta', {
        kind: 'approval/review', tool: request.name, callId: request.options.callId,
        ...event.decision,
      })
      await session.flush()
    })
  },
}
