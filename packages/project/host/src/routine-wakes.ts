import { randomUUID } from 'node:crypto'
import type { Context } from '@tnega/core'
import { nextRun, normalizeSchedule } from '@tnega/project-routines'
import type { ProjectHost } from './project-host.js'

/** The schedule kind of a project's routine in `ctx.effects`. */
export const ROUTINE_SCHEDULE = 'routine'

/** The effect that starts a turn for a run with no window open (v2 server MVP §4.7). */
export const RUN_WAKE = 'run.wake'

/** One schedule entry per project and routine. */
export function routineScheduleKey(projectId: string, routineId: string): string {
  return `${projectId}/${routineId}`
}

export interface ProjectRoutineWakesConfig {
  /** The Project host of a folder: the same one the HTTP routes use. */
  host: (workspace: string) => Promise<ProjectHost>
  /**
   * Folders whose projects to reconcile once at start (see
   * {@link ProjectHost.reconcile}): their routines get schedule entries and
   * projects that were working are woken. Leave out to skip.
   */
  workspaces?: () => Promise<readonly string[]>
  /** Told about a folder that could not be reconciled; the others go on. */
  onError?: (workspace: string, error: unknown) => void
}

function textField(payload: Readonly<Record<string, unknown>>, name: string): string {
  const value = payload[name]
  if (typeof value !== 'string' || !value) throw new TypeError(`run.wake payload has no ${name}`)
  return value
}

/**
 * Routines on a server: the schedule kind that turns a routine's entry into a
 * `run.wake` effect when it is due, and the handler that mounts the project
 * and runs the routine for that slot. Nobody needs to have the project open.
 * A wake for a slot that already ran, or for a routine or project that is
 * gone or paused, does nothing, so a repeated effect is harmless.
 */
export const projectRoutineWakes = {
  name: 'project-routine-wakes',
  inject: ['effects'],
  apply(ctx: Context, config: ProjectRoutineWakesConfig): void {
    const effects = ctx.get('effects')
    const stops = [
      effects.scheduleKind(ROUTINE_SCHEDULE, {
        effect: RUN_WAKE,
        payload: (entry, runAt) => ({ ...entry.spec, source: 'routine', runAt }),
        next: (spec, after) => nextRun(normalizeSchedule(spec.schedule), after),
      }),
      effects.handle(RUN_WAKE, async effect => {
        const source = effect.payload.source
        const workspace = textField(effect.payload, 'workspace')
        const projectId = textField(effect.payload, 'projectId')
        if (source === 'project') {
          // Mounting is the wake: the project loop delivers what is queued and recovers interrupted threads.
          const host = await config.host(workspace)
          if (await host.get(projectId)) await host.mount(projectId)
          return
        }
        // Another source is for a newer server: it waits, and shows in problems() after a few attempts.
        if (source !== 'routine') throw new Error(`run.wake from ${String(source)} has no handler in this server`)
        const routineId = textField(effect.payload, 'routineId')
        const runAt = effect.payload.runAt
        if (typeof runAt !== 'number') throw new TypeError('run.wake payload has no runAt')
        const host = await config.host(workspace)
        if (!await host.get(projectId)) {
          // The project was deleted: nothing will run this routine again.
          await effects.unschedule(ROUTINE_SCHEDULE, routineScheduleKey(projectId, routineId))
          return
        }
        const project = await host.mount(projectId)
        await project.routines.wake(routineId, runAt)
      }),
    ]
    ctx.fiber.effect(() => () => { for (const stop of stops.reverse()) stop() }, 'project-routine-wakes')
    const listed = config.workspaces
    if (listed) {
      const bootId = randomUUID()
      let stopped = false
      ctx.fiber.effect(() => () => { stopped = true }, 'stop reconciling projects')
      void (async () => {
        for (const workspace of await listed().catch(() => [])) {
          if (stopped) return
          try {
            await (await config.host(workspace)).reconcile(bootId)
          } catch (error) {
            config.onError?.(workspace, error)
          }
        }
      })()
    }
  },
}
