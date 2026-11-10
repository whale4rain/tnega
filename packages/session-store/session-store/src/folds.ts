import { foldApprovalMode } from '@tnega/approval-review'
import {
  estimateContextUsage,
  foldSessionMeta,
  foldSessionPermission,
  foldUsage,
  transcriptEvents,
  type ContextUsage,
  type MetaPatchPayload,
  type ModelMessage,
  type SessionEvent,
} from '@tnega/session'
import type {
  SessionMetaPatch,
  SessionPageOptions,
  SessionPageRange,
  SessionSnapshot,
  SessionSummary,
} from './index.js'

/**
 * Folds every store shares. A summary, a page of history and a snapshot are
 * pure functions of the events, so the JSONL and Postgres Providers answer
 * the same for the same log.
 */

/** The summary of a Session from its events; only meta and permission events change it. */
export function summaryFromEvents(
  workspace: string,
  id: string,
  events: readonly SessionEvent[],
  eventCount: number,
  updatedAtHint: number,
): SessionSummary {
  const headMeta = events.find(event => event.type === 'meta')
  const headPayload = headMeta?.payload as Record<string, unknown> | undefined
  const createdAt = headPayload && typeof headPayload.createdAt === 'number'
    ? headPayload.createdAt
    : Date.now()
  const folded = foldSessionMeta(events)
  const summary: SessionSummary = {
    id,
    title: folded.title ?? 'New session',
    workspace,
    createdAt,
    updatedAt: Math.max(createdAt, updatedAtHint),
    eventCount,
  }
  if (folded.agentType) summary.agentType = folded.agentType
  if (folded.mode) summary.mode = folded.mode
  if (folded.model) summary.model = folded.model
  if (folded.reasoningEffort) summary.reasoningEffort = folded.reasoningEffort
  summary.permission = foldSessionPermission(events)
  const approvalMode = foldApprovalMode(events)
  if (approvalMode) summary.approvalMode = approvalMode
  if (headPayload && typeof headPayload.parentSessionId === 'string') {
    summary.parentSessionId = headPayload.parentSessionId
  }
  if (headPayload && typeof headPayload.forkedAtMessageId === 'string') {
    summary.forkedAtMessageId = headPayload.forkedAtMessageId
  }
  return summary
}

/** Event types that can change a summary; a store may read only these to fold one. */
export const SUMMARY_EVENT_TYPES: readonly string[] = ['meta', 'meta/patch', 'permission/mode']

/** The context window the log itself recorded (a provider/limit change writes one). */
export function requestContextWindowOf(events: readonly SessionEvent[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.type !== 'request/context') continue
    const payload = event.payload as { contextWindow?: unknown }
    return typeof payload.contextWindow === 'number' ? payload.contextWindow : undefined
  }
  return undefined
}

const PAGE_MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])

/**
 * Cut the newest page of at most maxMessages transcript messages out of a log.
 * The cut lands on a turn/start so a turn is never split: a page that began
 * mid-turn would render a tool result without the call that produced it.
 */
export function pageWindow(
  events: readonly SessionEvent[],
  options: SessionPageOptions,
): { events: SessionEvent[]; page: SessionPageRange } {
  const asked = options.beforeSeq
  const end = asked === undefined
    ? events.length
    : Math.max(0, events.findIndex(event => event.seq >= asked))
  const limit = options.maxMessages !== undefined && options.maxMessages > 0 ? options.maxMessages : undefined
  // Without a page size the whole history up to the cursor is the window.
  let start = 0
  if (limit !== undefined) {
    let count = 0
    let cut = end
    for (let index = end - 1; index >= 0; index -= 1) {
      const event = events[index]!
      if (PAGE_MESSAGE_TYPES.has(event.type)) {
        count += 1
        cut = index
        if (count >= limit) break
      }
    }
    if (count >= limit) {
      // Keep the turn whole: back up to the turn/start that owns the cut message.
      let turnStart = cut
      for (let index = cut; index >= 0; index -= 1) {
        if (events[index]!.type === 'turn/start') {
          turnStart = index
          break
        }
      }
      start = turnStart
    }
  }
  // The oldest page absorbs the session preamble (head meta and any durable
  // system message); a page of nothing but preamble is not worth a request.
  const firstTurn = events.findIndex(event => event.type === 'turn/start')
  if (start > 0 && firstTurn >= 0 && start <= firstTurn) start = 0
  const window = events.slice(start, end)
  const hasMore = start > 0
  const beforeSeq = window[0]?.seq
  return {
    events: window,
    page: hasMore && beforeSeq !== undefined ? { hasMore, beforeSeq } : { hasMore },
  }
}

/** Events only the replay of a live stream reads; a reader of the history never shows them. */
const STREAM_ONLY_TYPES = new Set(['assistant/chunk'])

/**
 * Trim the transcript to what a reader of the history shows. Each assistant
 * message carries a copy of every streamed chunk for reconnecting streams;
 * on a long session that copy is over 90% of the log and a page of history
 * was tens of MB. A view only reads when the reasoning started and ended, so
 * the copy keeps just those records (see `reasoningDuration` in
 * `@tnega/client`). The stored log is unchanged.
 */
export function viewEvents(events: readonly SessionEvent[]): SessionEvent[] {
  return trimStreams(events.filter(event => !STREAM_ONLY_TYPES.has(event.type)))
}

/** Each assistant message's stream copy cut to its reasoning bounds; every other event as it is. */
export function trimStreams(events: readonly SessionEvent[]): SessionEvent[] {
  return events.map(event => {
    if (event.type !== 'assistant/message' || !event.payload.stream) return event
    const { stream, ...payload } = event.payload
    const kept = reasoningBounds(stream)
    return { ...event, payload: kept.length ? { ...payload, stream: kept } : payload }
  })
}

type StreamRecords = NonNullable<Extract<SessionEvent, { type: 'assistant/message' }>['payload']['stream']>

/** The first and last reasoning chunk, and the first chunk of anything after it. */
function reasoningBounds(stream: StreamRecords): StreamRecords {
  let first: StreamRecords[number] | undefined
  let last: StreamRecords[number] | undefined
  for (const record of stream) {
    if (record.chunk.type === 'reasoning_delta') {
      first ??= record
      last = record
    } else if (first && record.chunk.type !== 'message_start') {
      return last && last !== first ? [first, last, record] : [first, record]
    }
  }
  if (!first) return []
  return last && last !== first ? [first, last] : [first]
}

/**
 * How full the model's window is: the provider's own count from the newest
 * surface message when it reported one, the estimate otherwise.
 */
export function contextUsageOf(
  surface: readonly SessionEvent[],
  messages: readonly ModelMessage[],
  limit: number | undefined,
): ContextUsage {
  const estimate = estimateContextUsage([...messages], limit)
  const latest = surface.reduce<SessionEvent | undefined>(
    (found, event) => !found || event.seq > found.seq ? event : found,
    undefined,
  )
  if (latest?.type !== 'assistant/message' || !latest.payload.usage) return { ...estimate, source: 'estimate' }
  const tokens = latest.payload.usage.promptTokens
  return { ...estimate, tokens, ratio: estimate.limit > 0 ? tokens / estimate.limit : 0, source: 'provider' }
}

/** The parts of a log a snapshot is folded from, as `SessionLog` derives them. */
export interface SnapshotFolds {
  /** Every event, stream copies trimmed. */
  log: SessionEvent[]
  /** The model view, stream copies trimmed. */
  surface: SessionEvent[]
  messages: readonly ModelMessage[]
}

/** A {@link SessionSnapshot} from a log's folds: one page of the transcript, the folds over all of it. */
export function snapshotFromFolds(
  workspace: string,
  id: string,
  folds: SnapshotFolds,
  updatedAtHint: number,
  windowFor: ((model: string | undefined) => number | undefined) | undefined,
  pageOptions: SessionPageOptions,
): SessionSnapshot {
  const summary = summaryFromEvents(workspace, id, folds.log, folds.log.length, updatedAtHint)
  const limit = windowFor?.(summary.model) ?? requestContextWindowOf(folds.log)
  const window = pageWindow(folds.log, pageOptions)
  return {
    summary,
    events: viewEvents(transcriptEvents(window.events)),
    surface: folds.surface,
    context: contextUsageOf(folds.surface, folds.messages, limit),
    metrics: foldUsage(folds.log),
    log: folds.log,
    page: window.page,
  }
}

/** The `meta/patch` payload for the fields a patch names, or `undefined` when it names none. */
export function metaPatchPayload(patch: SessionMetaPatch): MetaPatchPayload | undefined {
  const fields: MetaPatchPayload['fields'] = []
  const payload: MetaPatchPayload = { fields }
  if (patch.title !== undefined) {
    fields.push('title')
    payload.title = patch.title.trim() || 'New session'
  }
  if (patch.agentType !== undefined) {
    fields.push('agentType')
    payload.agentType = patch.agentType
  }
  if (patch.mode !== undefined) {
    fields.push('mode')
    payload.mode = patch.mode
  }
  if (patch.model !== undefined) {
    fields.push('model')
    payload.model = patch.model
  }
  if (patch.reasoningEffort !== undefined) {
    fields.push('reasoningEffort')
    payload.reasoningEffort = patch.reasoningEffort
  }
  return fields.length ? payload : undefined
}

/** The fields of a patch that differ from the summary; a field already in force is left out. */
export function changedMeta(current: SessionSummary, patch: SessionMetaPatch): SessionMetaPatch {
  const changed: SessionMetaPatch = {}
  if (patch.title !== undefined && (patch.title.trim() || 'New session') !== current.title) changed.title = patch.title
  if (patch.agentType !== undefined && patch.agentType !== current.agentType) changed.agentType = patch.agentType
  if (patch.mode !== undefined && patch.mode !== current.mode) changed.mode = patch.mode
  if (patch.model !== undefined && patch.model !== current.model) changed.model = patch.model
  if (patch.reasoningEffort !== undefined && patch.reasoningEffort !== (current.reasoningEffort ?? 'default')) changed.reasoningEffort = patch.reasoningEffort
  return changed
}

/**
 * The events a fork copies after its own head meta. The fork's head carries
 * the source's current metadata, so the source's head and its meta patches
 * are left out; approval and run-summary meta events stay.
 */
export function forkBody(events: readonly SessionEvent[]): SessionEvent[] {
  return events.filter(event => {
    if (event.type === 'meta/patch') return false
    if (event.type !== 'meta') return true
    const kind: unknown = Reflect.get(event.payload, 'kind')
    return kind === 'approval/mode' || kind === 'approval/review' || kind === 'run/summary'
  })
}

/** A short stretch of `content` around the first match of `needle` (already lower case), on one line. */
export function searchSnippet(content: string, needle: string): string | undefined {
  const text = content.replace(/\s+/g, ' ').trim()
  const at = text.toLowerCase().indexOf(needle)
  if (at < 0) return undefined
  const start = Math.max(0, at - 30)
  const end = Math.min(text.length, at + needle.length + 70)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}
