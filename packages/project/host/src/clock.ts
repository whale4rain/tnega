import type { Context } from '@tnega/core'
import type { ToolDefinition } from '@tnega/tools'

/**
 * `now`: the current date and time.
 *
 * It belongs to the Project domain because routines, reports and the
 * coordinator reason about dates; a coding session reads the clock with
 * `shell` when it needs to, and pays nothing for a schema it would not use.
 */
export function nowTool(): ToolDefinition {
  return {
    schema: {
      name: 'now',
      description: 'Return the current date and time as an ISO 8601 string in the local timezone.',
      parameters: { type: 'object', properties: {} },
    },
    interruption: 'retry',
    isConcurrencySafe: () => true,
    execute: () => new Date().toISOString(),
  }
}

/** Mount `now` on this scope's registry. */
export const projectClock = {
  name: 'project-clock',
  inject: ['tools'],
  apply(ctx: Context): void {
    ctx.tools.register(nowTool())
  },
}
