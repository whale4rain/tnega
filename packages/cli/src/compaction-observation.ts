import type { Context, Fiber } from '@tnega/core'
import type { SessionEvent, SessionLog } from '@tnega/session'

/** Session events share a root bus; confirm membership in the exact live log. */
export async function observeCompaction(ctx: Context, session: SessionLog, emit: (event: Record<string, unknown>) => void): Promise<Fiber> {
  return await ctx.plugin({ name: 'compaction-web-observation', apply(scope: Context) {
    let pending = Promise.resolve()
    scope.on('session/event', (event: SessionEvent) => {
      if (event.type !== 'checkpoint') return
      if (event.payload.summary === undefined && event.payload.tokensBefore === undefined) return
      pending = pending.then(async () => {
        if (!(await session.read()).some(ownEvent => ownEvent.id === event.id)) return
        emit({ type: 'session/compaction', id: event.id, summary: event.payload.summary ?? '',
          ...(event.payload.tokensBefore !== undefined ? { tokensBefore: event.payload.tokensBefore } : {}),
        })
      })
    })
    scope.effect(() => async () => { await pending })
  } })
}
