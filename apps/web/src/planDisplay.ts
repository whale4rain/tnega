import type {
  PlanPayload,
  SessionEvent,
  SlashCommandResult,
  SlashMetaPayload,
  StreamEvent,
} from './types'

export interface DisplayPlanItem {
  id: string
  title: string
  status: 'pending' | 'done' | 'failed'
  detail?: string
}

export interface DisplayPlan {
  summary?: string
  items: DisplayPlanItem[]
  status: 'pending' | 'running' | 'done' | 'failed'
}

export const EMPTY_PLAN: DisplayPlan = {
  items: [],
  status: 'pending',
}

export function planFromPayload(payload: PlanPayload | undefined): DisplayPlan | undefined {
  if (!payload || !Array.isArray(payload.items) || payload.items.length === 0) {
    return undefined
  }
  const items: DisplayPlanItem[] = payload.items.map(item => ({
    id: item.id,
    title: item.title,
    status: item.status === 'done' || item.status === 'failed' ? item.status : 'pending',
    ...(item.detail ? { detail: item.detail } : {}),
  }))
  return {
    ...(payload.summary ? { summary: payload.summary } : {}),
    items,
    status: payload.status === 'running' || payload.status === 'done' || payload.status === 'failed'
      ? payload.status
      : 'pending',
  }
}

export function latestPlanFromEvents(events: readonly SessionEvent[]): DisplayPlan | undefined {
  let plan: DisplayPlan | undefined
  for (const event of events) {
    if (event.type !== 'plan') continue
    const next = planFromPayload(event.payload)
    if (next) plan = next
  }
  return plan
}

export function applyPlanStreamEvent(
  current: DisplayPlan | undefined,
  event: StreamEvent,
): DisplayPlan | undefined {
  switch (event.type) {
    case 'plan/start':
      return current
    case 'plan/items': {
      const next = planFromPayload(event.plan)
      return next ?? current
    }
    case 'plan/item': {
      if (!current) return current
      const target = event.item
      const status: DisplayPlanItem['status'] = target.status === 'done' || target.status === 'failed'
        ? target.status
        : 'pending'
      return {
        ...current,
        status: 'running',
        items: current.items.map(item => item.id === target.id
          ? {
              ...item,
              status,
              ...(target.detail ? { detail: target.detail } : {}),
            }
          : item),
      }
    }
    case 'plan/done':
      return planFromPayload(event.plan) ?? current
    case 'plan/error':
      return current
    default:
      return current
  }
}

export function planStatusText(plan: DisplayPlan | undefined): string {
  if (!plan) return ''
  if (plan.status === 'running') return 'running'
  if (plan.status === 'done') return 'done'
  if (plan.status === 'failed') return 'failed'
  const done = plan.items.filter(item => item.status === 'done').length
  const failed = plan.items.filter(item => item.status === 'failed').length
  if (done === plan.items.length && plan.items.length > 0) return 'done'
  if (failed > 0) return 'failed'
  if (done > 0) return `${done}/${plan.items.length}`
  return 'pending'
}

export function slashPromptParts(value: string): { name: string; args: string[] } | null {
  const trimmed = value.trim()
  if (!trimmed.startsWith('/')) return null
  const tokens = trimmed.slice(1).split(/\s+/).filter(Boolean)
  if (!tokens.length) return null
  const name = `/${tokens[0]!}`
  const args = tokens.slice(1)
  return { name, args }
}

export function formatSlashResult(
  result: { kind: 'text'; text: string } | { kind: 'json'; value: unknown },
): string {
  if (result.kind === 'text') return result.text
  return JSON.stringify(result.value, null, 2)
}

export function formatSlashMessage(
  command: string,
  args: readonly string[],
  result: SlashCommandResult,
): string {
  const line = [command, ...args].join(' ')
  return `${line}\n\n${formatSlashResult(result)}`
}

export function isSlashCommandResult(value: unknown): value is SlashCommandResult {
  if (typeof value !== 'object' || value === null) return false
  const record = value as { kind?: unknown; text?: unknown }
  if (record.kind === 'text') return typeof record.text === 'string'
  return record.kind === 'json'
}

export function formatSlashMetaEvent(event: SessionEvent): string | null {
  if (event.type !== 'meta') return null
  const payload = event.payload as Partial<SlashMetaPayload> & Record<string, unknown>
  if (
    payload.kind !== 'slash'
    || typeof payload.command !== 'string'
    || !Array.isArray(payload.args)
    || !isSlashCommandResult(payload.result)
  ) {
    return null
  }
  return formatSlashMessage(payload.command, payload.args, payload.result)
}
