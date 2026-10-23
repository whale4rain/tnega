import type { Context } from '@tnega/core'
import {
  completeAsStream,
  type AgentPreStepEvent,
  type AgentRequestEvent,
  type CompleteOptions,
  type LLMAdapter,
} from '@tnega/agent'
import type { ModelMessage, SessionEvent, SessionLog, SessionPermission } from '@tnega/session'

/**
 * Run settings that can change while a turn is running: the model, its
 * reasoning effort and the permission level.
 *
 * A change made mid-turn never touches the step that is already talking to the
 * model. It is picked up at the next step boundary, the way DSH does it: the
 * selection is snapshotted when a step is admitted and applied to that step's
 * request, so a step never mixes two selections. Each change is durable:
 *
 * - the model and effort land in the step's request options, so the agent's
 *   `request/header` records a `change` the first step they differ;
 * - a permission change is told to the model as a `system/message` that this
 *   plugin appends at the step boundary, where the loop can carry it in the
 *   same request (appending it from outside a running turn would leave the
 *   live request and the replayed one different).
 */

/** Author of the permission notice, so views and folds can recognise it. */
export const PERMISSION_NOTICE_NAME = 'plugin:permission'

/** Notices written before they had an author started with this. */
const LEGACY_PERMISSION_NOTICE = 'Session permission changed:'

/** The model route, model and effort one step runs with. */
export interface ModelSelection {
  /** Route id in the System Config (the model picker's id). */
  route: string
  /** Provider-side model name. */
  model: string
  reasoningEffort?: string
}

export interface RunSettingsOptions {
  /**
   * The Session of the agent about to take a step, or undefined to leave that
   * agent alone (subagents keep the settings they were spawned with).
   */
  session(agentId: string | undefined): SessionLog | undefined
  /** The selection in force now; read once per step. */
  selection?(): Promise<ModelSelection | undefined>
  /** What the model is told when the permission level changes. */
  permissionNotice?(level: SessionPermission): string
}

function isPermissionNotice(event: SessionEvent): boolean {
  return event.type === 'system/message' && (
    event.payload.name === PERMISSION_NOTICE_NAME
    || event.payload.content.startsWith(LEGACY_PERMISSION_NOTICE)
  )
}

/**
 * The level the model has not been told about yet, or undefined when it knows
 * the current one. A Session starts read-only, and the model is assumed to know
 * that much.
 */
export function pendingPermission(events: readonly SessionEvent[]): SessionPermission | undefined {
  let level: SessionPermission = 'read-only'
  let told: SessionPermission = 'read-only'
  for (const event of events) {
    if (event.type === 'permission/mode') level = event.payload.mode
    else if (isPermissionNotice(event)) told = level
  }
  return level === told ? undefined : level
}

/**
 * Append the permission notice when one is due. Returns the model message it
 * appended, so a step boundary can carry it in the same request.
 */
export async function deliverPermissionNotice(
  session: SessionLog,
  notice: (level: SessionPermission) => string,
): Promise<ModelMessage | undefined> {
  const level = pendingPermission(await session.read())
  if (!level) return undefined
  const content = notice(level)
  await session.append('system/message', { content, name: PERMISSION_NOTICE_NAME })
  return { role: 'system', content, name: PERMISSION_NOTICE_NAME }
}

function withSelection(options: CompleteOptions, selected: ModelSelection): CompleteOptions {
  const next: CompleteOptions = { ...options, provider: selected.route, model: selected.model }
  if (selected.reasoningEffort) next.reasoningEffort = selected.reasoningEffort
  else delete next.reasoningEffort
  return next
}

export const runSettings = {
  name: 'run-settings',
  apply(ctx: Context, options: RunSettingsOptions) {
    const snapshots = new Map<string, ModelSelection>()

    ctx.on('agent/pre-step', async (event: AgentPreStepEvent, next: () => unknown) => {
      const session = options.session(event.agentId)
      if (!session) return next()
      if (options.permissionNotice) {
        const notice = await deliverPermissionNotice(session, options.permissionNotice)
        if (notice) event.messages.push(notice)
      }
      const key = event.agentId ?? ''
      const selected = await options.selection?.()
      if (selected) snapshots.set(key, selected)
      else snapshots.delete(key)
      return next()
    })

    // Every attempt of a step (retries included) uses the step's snapshot.
    ctx.on('agent/request', async (event: AgentRequestEvent, next: () => unknown) => {
      const selected = snapshots.get(event.agentId ?? '')
      if (selected) event.options = withSelection(event.options, selected)
      return next()
    })

    ctx.on('agent/disposed', (event: { id: string }) => { snapshots.delete(event.id) })
  },
}

/**
 * One adapter that sends each call to the route its options name, so a model
 * or effort chosen mid-turn takes effect at the next step without rebuilding
 * the agent. Calls that name no route go to `fallback`.
 */
export function routedAdapter(
  adapterFor: (selection: ModelSelection) => LLMAdapter | Promise<LLMAdapter>,
  fallback: LLMAdapter,
): LLMAdapter {
  const pick = async (options: CompleteOptions): Promise<LLMAdapter> => options.provider && options.model
    ? adapterFor({
        route: options.provider,
        model: options.model,
        ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
      })
    : fallback
  return {
    async complete(messages, tools, options) {
      return (await pick(options)).complete(messages, tools, options)
    },
    stream(messages, tools, options) {
      return (async function* () {
        const adapter = await pick(options)
        yield* adapter.stream
          ? adapter.stream(messages, tools, options)
          : completeAsStream(adapter, messages, tools, options)
      })()
    },
  }
}

export const name = '@tnega/run-settings'
