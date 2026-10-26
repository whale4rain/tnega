import type { Context } from '@tnega/core'
import type { AgentRequestEvent } from './types.js'

/**
 * Restrict the tools one Agent sees, as a filter over the request.
 *
 * A scope that owns a role (a Project coordinator, a thread that may not spawn)
 * describes its surface as a predicate; every request then carries only the
 * tools that role uses, which keeps the prompt prefix small and stable for
 * provider caches. The matching guard is the caller's: hiding a tool does not
 * stop it being called by name from code mode.
 *
 * Lives here rather than in `@tnega/tools`, which the Agent depends on and
 * therefore cannot import back to type the event.
 */
export function scopeTools(ctx: Context, visible: (name: string) => boolean): void {
  ctx.on('agent/request', (request: AgentRequestEvent): AgentRequestEvent => ({
    ...request,
    tools: request.tools.filter(tool => visible(tool.schema.name)),
  }))
}
