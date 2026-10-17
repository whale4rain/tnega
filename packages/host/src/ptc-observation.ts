import type { Context, Fiber } from '@tnega/core'
import type { ToolRequest, ToolStagePayload } from '@tnega/tools'
import { renderToolResult } from '@tnega/session'

/** Observe nested calls before approval starts, without changing the tool pipeline. */
export async function observePtc(ctx: Context, agentId: string, emit: (event: Record<string, unknown>) => void): Promise<Fiber> {
  return await ctx.plugin({ name: 'ptc-web-observation', apply(scope: Context) {
    const belongs = (request: ToolRequest): boolean => typeof request.options.ptcParentCallId === 'string'
      && (!request.options.agentId || request.options.agentId === agentId)
    const bounded = (value: unknown): unknown => {
      const text = renderToolResult({ ok: true, output: value })
      return text.length > 64_000 ? { truncated: true, preview: text.slice(0, 64_000) } : value
    }
    scope.on('tools/pre-execute', (request: ToolRequest) => {
      if (belongs(request)) emit({ type: 'ptc/dispatch', payload: {
        kind: 'ptc/dispatch-start', parentCallId: request.options.ptcParentCallId,
        callId: request.options.callId, name: request.name, input: bounded(request.input),
      } })
      return request
    })
    scope.on('tools/result', ({ request, result }: ToolStagePayload) => {
      if (belongs(request)) emit({ type: 'ptc/dispatch', payload: {
        kind: 'ptc/dispatch', parentCallId: request.options.ptcParentCallId,
        callId: request.options.callId, name: request.name, ok: result.ok, result: bounded(result),
      } })
    })
  } })
}
