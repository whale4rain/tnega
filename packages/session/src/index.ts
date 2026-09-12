import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Context } from '@tnega/core'
import { checkSessionInvariants, type SessionInvariantFailure } from './invariant.js'

/**
 * v7 derives model-visible messages from the *folded surface* instead of from
 * raw file order, so compaction can stay strictly append-only.
 *
 * v6 rewrote the log on every real compaction: the kept tail was physically
 * reordered after the checkpoint (and every seq renumbered) purely so that a
 * file-order projection would equal the surface. v7 removes that coupling:
 * `deriveMessages()` walks the surface nodes in surface position order (a
 * replacement node may carry a *higher* seq than the nodes that follow it),
 * so compaction appends `compaction/start` → `checkpoint` (prefix +
 * `surfaceOp.replace` range) → `compaction/end` and never rewrites history.
 * To keep every surface node self-describing, `assistant/message` now carries
 * its own `toolCalls` (the assistant turn is not reassembled from separate
 * `tool/call` events at projection time).
 *
 * v8 adds terminal, log-only `assistant/attempt` records for attempts without
 * a surface message. Stream chunks are normalized before entering Session.
 * v7 and older logs are rejected without in-place migration.
 */
export const SESSION_FORMAT_VERSION = 8

/** Serialized tool schema, structurally compatible with @tnega/tools ToolSchema. */
export interface ToolSchemaSnapshot {
  name: string
  description: string
  parameters?: Record<string, unknown>
}

/** Call configuration recorded beside a request so it can be reconstructed. */
export interface LlmCallConfig {
  provider?: string
  model?: string
  maxTokens?: number
  temperature?: number
  reasoningEffort?: string
}

export class SessionFormatError extends Error {
  override name = 'SessionFormatError'
}

const liveSessions = new Map<string, SessionLog>()

function sessionFileKey(file: string): string {
  return resolve(file)
}

export type ModelRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ModelToolCall {
  id: string
  name: string
  arguments: unknown
}

export interface ModelMessage {
  role: ModelRole
  content: string
  name?: string
  tool_call_id?: string
  tool_calls?: ModelToolCall[]
  toolOk?: boolean
  toolError?: ToolResultErrorPayload
}

export interface UserMessagePayload {
  content: string
  name?: string
  parentId?: string
}

export interface AssistantMessagePayload {
  content: string
  name?: string
  parentId?: string
  interrupted?: boolean
  /**
   * The tool requests this assistant turn made, when it made any. The model
   * transcript is derived node-by-node from the surface, so an assistant turn
   * must carry its calls itself rather than being reassembled from the
   * separate (log-only) `tool/call` events that follow it.
   */
  toolCalls?: ModelToolCall[]
}

export interface AssistantChunkPayload {
  id: string
  content: string
  index?: number
}

/** Session-owned normalized model output; never a provider wire payload. */
export type AssistantStreamChunk =
  | { type: 'message_start'; id: string; model?: string }
  | { type: 'message_delta'; id: string; delta: string }
  | { type: 'toolcall_start'; id: string; index: number; name: string }
  | { type: 'toolcall_end'; id: string; index: number; name: string; arguments: unknown }
  | { type: 'message_stop'; id: string; finishReason: AssistantStreamFinishReason }
  | { type: 'stream_error'; error: ToolResultErrorPayload }

export type AssistantStreamFinishReason =
  | 'stop'
  | 'tool_calls'
  | 'length'
  | 'max_turns'
  | 'max_steps'
  | 'error'
  | 'cancelled'

/** One delivered chunk with its timestamp; array order preserves delivery order. */
export interface AssistantStreamRecord {
  time: number
  chunk: AssistantStreamChunk
}

/** Terminal settlement of an attempt that committed no assistant/message. */
export interface AssistantAttemptPayload {
  turn: number
  step: number
  /** May be empty when the request fails before delivering any chunks. */
  stream: AssistantStreamRecord[]
}

export interface SystemMessagePayload {
  content: string
  name?: string
  parentId?: string
}

export type MessageEventPayload =
  | UserMessagePayload
  | AssistantMessagePayload
  | SystemMessagePayload

export type MessageEventType = 'user/message' | 'assistant/message' | 'system/message'

export interface CompactionStartPayload {
  boundary?: number
  keep?: number
  tokensBefore?: number
}

export interface CompactionEndPayload {
  checkpointId?: string
  keep?: number
}

export interface ToolCallPayload {
  id: string
  name: string
  arguments: unknown
  /** Exact raw arguments JSON as produced by the model; preserves serialization. */
  argRaw?: string
  turn?: number
  step?: number
}

export interface ToolResultErrorPayload {
  name?: string
  message: string
  stack?: string
}

export interface ToolResultPayload {
  id: string
  toolCallId: string
  name: string
  ok: boolean
  durationMs?: number
  output?: unknown
  error?: ToolResultErrorPayload
  argRaw?: string
  turn?: number
  step?: number
}

export type CancelCause =
  | { type: 'user' }
  | { type: 'parent' }
  | { type: 'disposed' }
  | { type: 'abort'; message?: string }
  | { type: 'timeout'; timeoutMs: number }

/**
 * Why a turn ended — the durable machine outcome, distinct from the
 * per-step model `finishReason`. Written on `turn/end`.
 */
export type TurnEndReason =
  | { kind: 'completed' }
  | { kind: 'aborted'; cause: CancelCause }
  | { kind: 'blocked' }
  | { kind: 'error'; error: ToolResultErrorPayload }
  | { kind: 'max-tokens' }
  | { kind: 'max-steps' }
  | { kind: 'max-turns' }
  | { kind: 'interrupted' }

export interface TurnStartPayload {
  turn: number
  input?: unknown
  reason?: string
}

export interface TurnEndPayload {
  turn: number
  finishReason?: string
  /** The typed durable reason this turn ended. Supersedes `finishReason`. */
  reason?: TurnEndReason
  output?: string
  steps?: number
  interrupted?: boolean
  cancelCause?: CancelCause
  error?: ToolResultErrorPayload
}

export interface StepStartPayload {
  turn: number
  step: number
}

export interface StepEndPayload {
  turn: number
  step: number
  finishReason?: string
  toolCalls?: number
  interrupted?: boolean
  cancelCause?: CancelCause
  error?: ToolResultErrorPayload
}

export interface LLMRetryPayload {
  retryId: string
  retry: number
  delayMs?: number
  failure?: ToolResultErrorPayload
}

export interface LLMRetryStartedPayload {
  retryId: string
  retry: number
}

/** How a `request/header` snapshot enters the log. */
export type RequestHeaderReason =
  | 'initial'
  | 'resume'
  | 'change'
  | 'series'
  | 'change-series'

export interface RequestHeaderPayload {
  reason: RequestHeaderReason
  config?: LlmCallConfig
  /** Rendered system prompt; absent for a system-less request. */
  system?: string
  /** Assembled tool schemas; absent for a tool-less request. */
  tools?: ToolSchemaSnapshot[]
  /** True when this snapshot also begins a new model-message series. */
  startsSeries?: boolean
}

export interface RequestContextPayload {
  provider?: string
  model?: string
  contextWindow?: number
}

export interface CheckpointPayload {
  /** The compacted prefix: messages the model keeps seeing after compaction. */
  messages: ModelMessage[]
  summary?: string
  tokensBefore?: number
  /**
   * The surface span this checkpoint shadows, when written by a v7
   * compaction: `start`/`end` are the seqs of the first and last *surface
   * nodes* being replaced (surface positions, so `start` may be numerically
   * greater than `end` after an earlier compaction). The fold removes every
   * live node between those two positions and inserts this checkpoint there;
   * the kept tail stays in place and the log is never rewritten.
   * `'replace'` (bare string) is the legacy v5 form and shadows nothing
   * structurally; projection treats it as a full-surface seed.
   */
  surfaceOp?: { op: 'replace'; start: number; end: number } | 'replace'
  /** @deprecated v0.2 keeps raw events in place; use messages instead. */
  snapshot?: SessionEvent[]
}

export type PlanItemStatus = 'pending' | 'done' | 'failed'

export interface PlanItemPayload {
  id: string
  title: string
  status: PlanItemStatus
  detail?: string
}

export interface PlanPayload {
  items: PlanItemPayload[]
  status?: 'pending' | 'running' | 'done' | 'failed'
  summary?: string
}

export interface InboxSplicePayload {
  target: 'next-turn' | 'next-step'
  index?: number
  deleteCount?: number
  inserted?: Array<{
    id: string
    content: string
    /** Structured message payload preserved across restart when present. */
    payload?: unknown
    mode?: 'followup' | 'steer'
  }>
}

/** A durable change to session display metadata (title, mode, agentType). */
export interface MetaPatchPayload {
  /** Keys changed by this event; only present keys are touched. */
  fields: Array<'title' | 'agentType' | 'mode'>
  title?: string
  agentType?: AgentType
  mode?: SessionMode
}

export type AgentType = 'general' | 'coding'

export type SessionMode = 'auto' | 'plan' | 'execute'

export type SessionEventType =
  | MessageEventType
  | 'assistant/chunk'
  | 'assistant/attempt'
  | 'tool/call'
  | 'tool/result'
  | 'request/header'
  | 'request/context'
  | 'agent/inbox/spliced'
  | 'plan'
  | 'checkpoint'
  | 'compaction/start'
  | 'compaction/end'
  | 'meta'
  | 'meta/patch'
  | 'llm/retry'
  | 'llm/retry-started'
  | 'turn/start'
  | 'turn/end'
  | 'step/start'
  | 'step/end'

export interface SessionEventBase<T extends SessionEventType, P> {
  id: string
  seq: number
  ts: number
  type: T
  payload: P
  /** Surface placement; required on message-producing events. */
  surfaceOp?: SurfaceOp
  /** Seqs of earlier raw events this event derives from. */
  sourceEventSeqs?: number[]
}

/**
 * The message-producing subset of event types. Every variant is a surface
 * node that carries `surfaceOp` and participates in the ordered fold.
 * `system/message` is included because tnega keeps the system prompt on the
 * transcript (OpenAI-style), so it must be replaceable and derivable like any
 * other message rather than living only in `request/header`.
 */
export type SurfaceEventType =
  | 'user/message'
  | 'system/message'
  | 'assistant/message'
  | 'tool/result'

export type SurfaceOp = 'append' | { op: 'replace'; start: number; end: number }

export type SessionEvent =
  | SessionEventBase<'user/message', UserMessagePayload>
  | SessionEventBase<'assistant/message', AssistantMessagePayload>
  | SessionEventBase<'assistant/chunk', AssistantChunkPayload>
  | SessionEventBase<'assistant/attempt', AssistantAttemptPayload>
  | SessionEventBase<'system/message', SystemMessagePayload>
  | SessionEventBase<'tool/call', ToolCallPayload>
  | SessionEventBase<'tool/result', ToolResultPayload>
  | SessionEventBase<'request/header', RequestHeaderPayload>
  | SessionEventBase<'request/context', RequestContextPayload>
  | SessionEventBase<'agent/inbox/spliced', InboxSplicePayload>
  | SessionEventBase<'plan', PlanPayload>
  | SessionEventBase<'checkpoint', CheckpointPayload>
  | SessionEventBase<'compaction/start', CompactionStartPayload>
  | SessionEventBase<'compaction/end', CompactionEndPayload>
  | SessionEventBase<'meta', Record<string, unknown>>
  | SessionEventBase<'meta/patch', MetaPatchPayload>
  | SessionEventBase<'llm/retry', LLMRetryPayload>
  | SessionEventBase<'llm/retry-started', LLMRetryStartedPayload>
  | SessionEventBase<'turn/start', TurnStartPayload>
  | SessionEventBase<'turn/end', TurnEndPayload>
  | SessionEventBase<'step/start', StepStartPayload>
  | SessionEventBase<'step/end', StepEndPayload>

function isMessageEventType(type: SessionEventType): type is MessageEventType {
  return type === 'user/message'
    || type === 'assistant/message'
    || type === 'system/message'
}

function isMessageEvent(
  event: SessionEvent,
): event is Extract<SessionEvent, { type: MessageEventType }> {
  return isMessageEventType(event.type)
}

export interface SessionConfig {
  file: string
  broadcast?: SessionBroadcast
}

export interface CompactOptions {
  keep?: number
  keepTokens?: number
  summary?: string
  tokensBefore?: number
  messages?: ModelMessage[]
}

export type ReplayReducer<T> = (state: T, event: SessionEvent) => T | Promise<T>

export type SessionBroadcast = (
  type: 'event' | 'flush',
  payload: unknown,
) => void

export interface ContextUsage {
  tokens: number
  limit: number
  ratio: number
}

export const DEFAULT_CONTEXT_LIMIT = 128_000

function isSessionEvent(value: unknown): value is SessionEvent {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string'
    && typeof record.seq === 'number'
    && typeof record.ts === 'number'
    && typeof record.type === 'string'
    && 'payload' in record
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function previousSurfaceSeq(nodes: readonly number[]): number | undefined {
  return nodes.at(-1)
}

/**
 * Project an event list to model messages, in the list's own order. Each
 * surface event is mapped through {@link deriveEventMessage}; a `checkpoint`
 * splices its compacted prefix in at its position. This is the building block
 * both {@link deriveSurfaceMessages} (surface order) and callers holding a
 * compact slice (e.g. the events a summarizer will read) share.
 */
export function projectEvents(events: readonly SessionEvent[]): ModelMessage[] {
  const messages: ModelMessage[] = []
  for (const event of events) {
    if (event.type === 'checkpoint') {
      messages.splice(0, messages.length, ...clone(event.payload.messages))
      continue
    }
    const message = deriveEventMessage(event)
    if (message) messages.push(message)
  }
  return messages
}

export function isAppendSurfaceEvent(event: SessionEvent): boolean {
  return isSurfaceEventType(event.type) && event.surfaceOp === 'append'
}

export function isSurfaceEventType(type: SessionEventType): type is SurfaceEventType {
  return type === 'user/message'
    || type === 'system/message'
    || type === 'assistant/message'
    || type === 'tool/result'
}

/** A v7 checkpoint shadows a surface span; legacy ('replace') shadows nothing structurally. */
export function checkpointShadowRange(
  event: SessionEvent,
): { start: number; end: number } | undefined {
  if (event.type !== 'checkpoint') return undefined
  const op = event.payload.surfaceOp
  if (typeof op === 'object' && op !== null && op.op === 'replace') {
    return { start: op.start, end: op.end }
  }
  return undefined
}

/** Detached current surface nodes plus every replacement's shadowed ranges. */
export interface SurfaceFoldReplacement {
  seq: number
  start: number
  end: number
  shadowedSeqs: number[]
}

export interface SurfaceFoldResult {
  nodes: number[]
  replacements: SurfaceFoldReplacement[]
}

/**
 * Fold a log's surface operations into the current surface node order.
 *
 * The surface is *positional*: a replacement removes the live nodes between
 * the positions of `start`/`end` and inserts the replacing event's seq there,
 * so surface order is independent of raw seq order — after compaction the
 * checkpoint node may carry a higher seq than the kept tail that follows it.
 */
export function foldSurface(events: readonly SessionEvent[]): SurfaceFoldResult {
  const nodes: number[] = []
  const replacements: SurfaceFoldReplacement[] = []

  const applyReplace = (seq: number, start: number, end: number): void => {
    const startIndex = nodes.indexOf(start)
    if (startIndex < 0) {
      // The shadowed head is already gone (defensive; our writer always
      // shadows live nodes). Keep the prefix visible by anchoring at the tail.
      nodes.push(seq)
      return
    }
    const endIndex = nodes.indexOf(end, startIndex)
    if (endIndex < 0) {
      nodes.push(seq)
      return
    }
    const shadowed = nodes.splice(startIndex, endIndex - startIndex + 1)
    nodes.splice(startIndex, 0, seq)
    replacements.push({ seq, start, end, shadowedSeqs: shadowed })
  }

  for (const event of events) {
    if (event.type === 'checkpoint') {
      const range = checkpointShadowRange(event)
      if (!range) {
        // A range-less checkpoint is a prefix seed: it contributes its own
        // node at its surface position (used when compaction runs before any
        // durable history exists to shadow).
        nodes.push(event.seq)
        continue
      }
      applyReplace(event.seq, range.start, range.end)
      continue
    }
    if (!isSurfaceEventType(event.type)) continue
    const op = event.surfaceOp ?? 'append'
    if (op === 'append') {
      nodes.push(event.seq)
      continue
    }
    applyReplace(event.seq, op.start, op.end)
  }
  return { nodes, replacements }
}

/**
 * Derive one surface node's model-visible message. A content-less assistant
 * turn (e.g. a max-token cutoff with no output and no tool calls) is skipped
 * so it never enters a provider transcript; `tool/result` yields the `tool`
 * role message that pairs with the assistant's `toolCalls`.
 */
export function deriveEventMessage(event: SessionEvent): ModelMessage | null {
  switch (event.type) {
    case 'user/message': {
      const message: ModelMessage = { role: 'user', content: event.payload.content }
      if (event.payload.name) message.name = event.payload.name
      return message
    }
    case 'system/message': {
      const message: ModelMessage = { role: 'system', content: event.payload.content }
      if (event.payload.name) message.name = event.payload.name
      return message
    }
    case 'assistant/message': {
      const toolCalls = event.payload.toolCalls
      if (!event.payload.content && !(toolCalls && toolCalls.length)) return null
      const message: ModelMessage = { role: 'assistant', content: event.payload.content }
      if (event.payload.name) message.name = event.payload.name
      if (toolCalls?.length) message.tool_calls = clone(toolCalls)
      return message
    }
    case 'tool/result': {
      const failed = !event.payload.ok
      const message: ModelMessage = {
        role: 'tool',
        content: failed
          ? `error: ${event.payload.error?.message ?? 'unknown'}`
          : stringify(event.payload.output),
        tool_call_id: event.payload.toolCallId,
      }
      message.name = event.payload.name
      if (failed) {
        message.toolOk = false
        if (event.payload.error) message.toolError = event.payload.error
      }
      return message
    }
    default:
      return null
  }
}

/**
 * Derive the model transcript strictly from the folded surface: walk the
 * surface nodes in surface position order (so a checkpoint's prefix is placed
 * where it replaced history, whatever its raw seq), mapping each node through
 * {@link deriveEventMessage}. This is the single source of the model's view;
 * raw log order never influences it.
 */
export function deriveSurfaceMessages(events: readonly SessionEvent[]): ModelMessage[] {
  const { nodes } = foldSurface(events)
  const bySeq = new Map(events.map(event => [event.seq, event] as const))
  const messages: ModelMessage[] = []
  for (const seq of nodes) {
    const event = bySeq.get(seq)
    if (!event) continue
    if (event.type === 'checkpoint') {
      messages.splice(0, messages.length, ...clone(event.payload.messages))
      continue
    }
    const message = deriveEventMessage(event)
    if (message) messages.push(message)
  }
  return messages
}

/**
 * Project the log into a human-facing transcript (the web view). Unlike the
 * model surface, a compaction does **not** hide the history it summarized:
 * shadowed messages are kept in place, and each live checkpoint is retained
 * as a marker exactly where it replaced them (with nested checkpoints
 * expanded recursively). Readers see the full conversation; the model keeps
 * deriving from the folded surface via {@link deriveSurfaceMessages}.
 */
export function transcriptEvents(events: readonly SessionEvent[]): SessionEvent[] {
  const bySeq = new Map(events.map(event => [event.seq, event] as const))
  const { nodes, replacements } = foldSurface(events)

  const shadowedOf = new Map<number, SessionEvent[]>()
  for (const replacement of replacements) {
    shadowedOf.set(replacement.seq, replacement.shadowedSeqs
      .map(seq => bySeq.get(seq))
      .filter((event): event is SessionEvent => event !== undefined))
  }

  const isVisible = (event: SessionEvent): boolean => (
    event.type !== 'system/message' && isSurfaceEventType(event.type)
  )

  const skeleton: SessionEvent[] = []
  const appendHistory = (checkpointSeq: number): void => {
    for (const shadowed of shadowedOf.get(checkpointSeq) ?? []) {
      if (shadowed.type === 'checkpoint') appendHistory(shadowed.seq)
      else if (isVisible(shadowed)) skeleton.push(shadowed)
    }
  }
  for (const seq of nodes) {
    const event = bySeq.get(seq)
    if (!event) continue
    if (event.type === 'checkpoint') appendHistory(event.seq)
    skeleton.push(event)
  }

  // Declared tool calls travel on their assistant message, so the matching
  // log-only `tool/call` records would double-render: drop those, keep the
  // legacy ones that have no assistant declaration.
  const declaredCalls = new Set<string>()
  for (const event of events) {
    if (event.type === 'assistant/message') {
      for (const call of event.payload.toolCalls ?? []) declaredCalls.add(call.id)
    }
  }
  const inSkeleton = new Set(skeleton.map(event => event.id))
  const structure = events
    .filter(event => !inSkeleton.has(event.id))
    .filter(event => event.type !== 'compaction/start' && event.type !== 'compaction/end')
    .filter(event => event.type !== 'checkpoint') // superseded markers: history shown via the live chain
    .filter(event => !(event.type === 'tool/call' && declaredCalls.has(event.payload.id)))

  const ordered = [...skeleton]
  for (const event of structure) {
    let index = ordered.length
    for (let cursor = ordered.length - 1; cursor >= 0; cursor -= 1) {
      if (ordered[cursor]!.seq <= event.seq) {
        index = cursor + 1
        break
      }
    }
    ordered.splice(index, 0, event)
  }
  return ordered
}

export function foldRequestHeader(events: readonly SessionEvent[]): RequestHeaderPayload | undefined {
  let header: RequestHeaderPayload | undefined
  for (const event of events) {
    if (event.type === 'request/header') header = clone(event.payload)
  }
  return header
}

export function foldRequestContext(events: readonly SessionEvent[]): RequestContextPayload | undefined {
  let context: RequestContextPayload | undefined
  for (const event of events) {
    if (event.type === 'request/context') context = clone(event.payload)
  }
  return context
}

/**
 * Session display metadata, rebuilt from the immutable events: the head
 * `meta` base followed by every `meta/patch` in seq order. No mutable
 * side file or in-place rewrite is involved, so title/mode/agentType stay
 * replayable and fork-clean like every other durable fact.
 */
export function foldSessionMeta(events: readonly SessionEvent[]): {
  title?: string
  agentType?: AgentType
  mode?: SessionMode
} {
  const meta: { title?: string; agentType?: AgentType; mode?: SessionMode } = {}
  for (const event of events) {
    if (event.type === 'meta') {
      const payload = event.payload as Record<string, unknown>
      if (typeof payload.title === 'string') meta.title = payload.title
      if (payload.agentType === 'general' || payload.agentType === 'coding') {
        meta.agentType = payload.agentType
      }
      if (payload.mode === 'auto' || payload.mode === 'plan' || payload.mode === 'execute') {
        meta.mode = payload.mode
      }
      continue
    }
    if (event.type === 'meta/patch') {
      const patch = event.payload
      if (patch.fields.includes('title') && typeof patch.title === 'string') {
        meta.title = patch.title
      }
      if (patch.fields.includes('agentType') && patch.agentType !== undefined) {
        meta.agentType = patch.agentType
      }
      if (patch.fields.includes('mode') && patch.mode !== undefined) {
        meta.mode = patch.mode
      }
    }
  }
  return meta
}

/** Convenience wrapper: fold session metadata from a `SessionLog`'s events. */
export function foldMetaFromLog(log: { read(): Promise<SessionEvent[]> }): Promise<{
  title?: string
  agentType?: AgentType
  mode?: SessionMode
}> {
  return log.read().then(foldSessionMeta)
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

export function estimateMessageTokens(messages: readonly ModelMessage[]): number {
  let tokens = 0
  for (const message of messages) {
    tokens += Math.ceil(message.content.length / 4)
    for (const call of message.tool_calls ?? []) {
      const raw = JSON.stringify(call.arguments ?? {}) ?? ''
      tokens += Math.ceil(raw.length / 4)
    }
  }
  return tokens
}

export function estimateEventTokens(event: SessionEvent): number {
  switch (event.type) {
    case 'user/message':
    case 'system/message':
      return Math.ceil(event.payload.content.length / 4)
    case 'assistant/message': {
      let tokens = Math.ceil(event.payload.content.length / 4)
      for (const call of event.payload.toolCalls ?? []) {
        const raw = JSON.stringify(call.arguments ?? {}) ?? ''
        tokens += Math.ceil(raw.length / 4)
      }
      return tokens
    }
    case 'assistant/chunk':
      return Math.ceil(event.payload.content.length / 4)
    case 'tool/call': {
      const raw = JSON.stringify(event.payload.arguments ?? {}) ?? ''
      return Math.ceil(raw.length / 4)
    }
    case 'tool/result': {
      const raw = event.payload.ok
        ? stringify(event.payload.output)
        : event.payload.error?.message ?? 'error'
      return Math.ceil(raw.length / 4)
    }
    case 'plan':
    case 'assistant/attempt':
      return 0
    case 'checkpoint':
      return estimateMessageTokens(event.payload.messages)
    case 'compaction/start':
    case 'compaction/end':
    case 'meta':
    case 'meta/patch':
      return 0
    case 'llm/retry':
    case 'llm/retry-started':
      return 0
    case 'request/header':
    case 'request/context':
    case 'agent/inbox/spliced':
      return 0
    case 'turn/start':
    case 'turn/end':
    case 'step/start':
    case 'step/end':
      return 0
  }
}

export function suffixStartIndexForTokens(
  events: readonly SessionEvent[],
  targetTokens: number,
): number {
  if (!events.length || targetTokens <= 0) return 0
  let tokens = 0
  let candidate = events.length
  for (let index = events.length - 1; index >= 0; index -= 1) {
    tokens += estimateEventTokens(events[index]!)
    if (tokens >= targetTokens) {
      candidate = index
      break
    }
  }
  if (candidate === events.length) return 0
  let cut = candidate
  while (cut < events.length) {
    const event = events[cut]
    if (event?.type === 'user/message') return cut
    cut += 1
  }
  return candidate
}

export function safeCompactSplit(
  events: readonly SessionEvent[],
  splitIndex: number,
): number {
  const index = Math.max(0, Math.min(splitIndex, events.length))
  const first = events[index]
  if (first?.type === 'tool/result') {
    const callId = first.payload.toolCallId
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const candidate = events[cursor]
      if (candidate?.type === 'tool/call' && candidate.payload.id === callId) {
        return cursor
      }
    }
  }

  let openCalls = 0
  for (let cursor = 0; cursor <= events.length; cursor += 1) {
    if (cursor >= index && openCalls === 0) return cursor
    const event = events[cursor]
    if (!event) continue
    if (event.type === 'tool/call') openCalls += 1
    if (event.type === 'tool/result') openCalls = Math.max(0, openCalls - 1)
  }
  return index
}

export function repairUnclosed(
  events: readonly SessionEvent[],
): SessionEvent[] {
  const openCalls: Extract<SessionEvent, { type: 'tool/call' }>[] = []
  const openSteps: Extract<SessionEvent, { type: 'step/start' }>[] = []
  const openTurns: Extract<SessionEvent, { type: 'turn/start' }>[] = []
  for (const event of events) {
    switch (event.type) {
      case 'tool/call':
        openCalls.push(event)
        break
      case 'tool/result': {
        const callIndex = openCalls.findIndex(
          call => call.payload.id === event.payload.toolCallId,
        )
        if (callIndex >= 0) openCalls.splice(callIndex, 1)
        else openCalls.pop()
        break
      }
      case 'step/start':
        openSteps.push(event)
        break
      case 'step/end':
        openSteps.pop()
        break
      case 'turn/start':
        openTurns.push(event)
        break
      case 'turn/end':
        openTurns.pop()
        break
    }
  }

  if (!openCalls.length && !openSteps.length && !openTurns.length) return []

  const synthetic: SessionEvent[] = []
  let nextSeq = (events.at(-1)?.seq ?? 0) + 1
  let nextTs = (events.at(-1)?.ts ?? Date.now()) + 1
  const push = (type: SessionEventType, payload: SessionEvent['payload']): void => {
    synthetic.push({
      id: randomUUID(),
      seq: nextSeq,
      ts: nextTs,
      type: type as SessionEvent['type'],
      payload: clone(payload),
    } as SessionEvent)
    nextSeq += 1
    nextTs += 1
  }

  for (const call of openCalls) {
    push('tool/result', {
      id: call.payload.id,
      toolCallId: call.payload.id,
      name: call.payload.name,
      ok: false,
      error: {
        name: 'SessionInterruptedError',
        message: 'session interrupted before tool result was recorded',
      },
    })
  }
  for (const step of openSteps) {
    push('step/end', {
      turn: step.payload.turn,
      step: step.payload.step,
      finishReason: 'interrupted',
      interrupted: true,
    })
  }
  for (let i = 0; i < openTurns.length; i++) {
    const turn = openTurns[i]!.payload.turn
    push('turn/end', {
      turn,
      finishReason: 'interrupted',
      interrupted: true,
    })
  }
  return synthetic
}

export function resolveCompactKeep(
  events: readonly SessionEvent[],
  options: CompactOptions,
): number {
  if (
    typeof options.keepTokens === 'number'
    && Number.isFinite(options.keepTokens)
    && options.keepTokens > 0
  ) {
    return events.length - suffixStartIndexForTokens(events, options.keepTokens)
  }
  const keep = typeof options.keep === 'number' && Number.isFinite(options.keep) && options.keep > 0
    ? Math.floor(options.keep)
    : 0
  return Math.min(keep, events.length)
}

export function estimateContextUsage(
  messages: readonly ModelMessage[],
  limit = DEFAULT_CONTEXT_LIMIT,
): ContextUsage {
  const tokens = estimateMessageTokens(messages)
  return {
    tokens,
    limit,
    ratio: limit > 0 ? tokens / limit : 0,
  }
}

export class SessionLog {
  private _events: SessionEvent[] = []
  private _surface: ModelMessage[] = []
  private _surfaceNodes: number[] = []
  private _requestHeader: RequestHeaderPayload | undefined
  private _requestContext: RequestContextPayload | undefined
  private _loaded = false
  private _nextSeq = 1
  private _queue: Promise<unknown> = Promise.resolve()
  private _writeTail: Promise<void> = Promise.resolve()
  private _pending: SessionEvent[] = []
  private _drainScheduled = false
  private _writeError: unknown

  constructor(
    readonly file: string,
    private _broadcast?: SessionBroadcast,
  ) {}

  init(): Promise<void> {
    return this._run(async () => {
      const key = sessionFileKey(this.file)
      if (!liveSessions.has(key)) liveSessions.set(key, this)
      try {
        await this._ensureLoaded()
        await this._drainWrite()
        if (this._writeError) {
          const error = this._writeError
          this._writeError = undefined
          throw error
        }
      } catch (error) {
        if (liveSessions.get(key) === this) liveSessions.delete(key)
        throw error
      }
    })
  }

  append(type: 'user/message', payload: UserMessagePayload): Promise<SessionEvent>
  append(type: 'assistant/message', payload: AssistantMessagePayload): Promise<SessionEvent>
  append(type: 'assistant/chunk', payload: AssistantChunkPayload): Promise<SessionEvent>
  append(type: 'assistant/attempt', payload: AssistantAttemptPayload): Promise<SessionEvent>
  append(type: 'system/message', payload: SystemMessagePayload): Promise<SessionEvent>
  append(type: 'tool/call', payload: ToolCallPayload): Promise<SessionEvent>
  append(type: 'tool/result', payload: ToolResultPayload): Promise<SessionEvent>
  append(type: 'request/header', payload: RequestHeaderPayload): Promise<SessionEvent>
  append(type: 'request/context', payload: RequestContextPayload): Promise<SessionEvent>
  append(type: 'agent/inbox/spliced', payload: InboxSplicePayload): Promise<SessionEvent>
  append(type: 'plan', payload: PlanPayload): Promise<SessionEvent>
  append(type: 'checkpoint', payload: CheckpointPayload): Promise<SessionEvent>
  append(type: 'compaction/start', payload: CompactionStartPayload): Promise<SessionEvent>
  append(type: 'compaction/end', payload: CompactionEndPayload): Promise<SessionEvent>
  append(type: 'meta', payload: Record<string, unknown>): Promise<SessionEvent>
  append(type: 'meta/patch', payload: MetaPatchPayload): Promise<SessionEvent>
  append(type: 'llm/retry', payload: LLMRetryPayload): Promise<SessionEvent>
  append(type: 'llm/retry-started', payload: LLMRetryStartedPayload): Promise<SessionEvent>
  append(type: 'turn/start', payload: TurnStartPayload): Promise<SessionEvent>
  append(type: 'turn/end', payload: TurnEndPayload): Promise<SessionEvent>
  append(type: 'step/start', payload: StepStartPayload): Promise<SessionEvent>
  append(type: 'step/end', payload: StepEndPayload): Promise<SessionEvent>
  append(type: SessionEventType, payload: SessionEvent['payload']): Promise<SessionEvent> {
    return this._run(async () => {
      await this._ensureLoaded()
      const event = this._buildEvent(type, payload)
      this._commitEvent(event)
      return event
    })
  }

  private _buildEvent(
    type: SessionEventType,
    payload: SessionEvent['payload'],
  ): SessionEvent {
      const eventPayload = clone(payload)
      const event = {
        id: randomUUID(),
        seq: this._nextSeq,
        ts: Date.now(),
        type: type as SessionEvent['type'],
        payload: eventPayload,
      } as SessionEvent
      if (isMessageEventType(type)) {
        for (let index = this._events.length - 1; index >= 0; index -= 1) {
          const previous = this._events[index]
          if (previous && isMessageEvent(previous)) {
            const messagePayload = eventPayload as MessageEventPayload
            messagePayload.parentId ??= previous.id
            break
          }
        }
        event.surfaceOp ??= 'append'
        const previous = previousSurfaceSeq(this._surfaceNodes)
        event.sourceEventSeqs ??= previous === undefined ? [] : [previous]
      } else if (type === 'request/header') {
        event.sourceEventSeqs ??= []
      } else if (type === 'request/context') {
        event.sourceEventSeqs ??= []
      } else if (type === 'agent/inbox/spliced') {
        event.sourceEventSeqs ??= []
      }
      this._nextSeq += 1
      return event
  }

  private _commitEvent(event: SessionEvent): void {
    this._events.push(event)
    this._refreshSurface()
    if (event.type === 'request/header') this._requestHeader = clone(event.payload)
    if (event.type === 'request/context') this._requestContext = clone(event.payload)
    this._broadcast?.('event', event)
    this._enqueue(event)
  }

  /**
   * Rebuild both surface views from the committed log. The nodes come from the
   * positional {@link foldSurface} fold; the messages come from
   * {@link deriveSurfaceMessages}, which walks those nodes in surface order —
   * the model view is a pure function of the surface, never of raw file order.
   */
  private _refreshSurface(): void {
    this._surfaceNodes = foldSurface(this._events).nodes
    this._surface = deriveSurfaceMessages(this._events)
  }

  private _enqueue(event: SessionEvent): void {
    this._pending.push(event)
    if (this._drainScheduled) return
    this._drainScheduled = true
    setImmediate(() => {
      this._drainScheduled = false
      void this._drainWrite()
    })
  }

  private _drainWrite(): Promise<void> {
    const events = this._pending.splice(0)
    if (!events.length) return this._writeTail
    const write = this._writeTail.then(() => appendFile(
      this.file,
      `${events.map(event => JSON.stringify(event)).join('\n')}\n`,
      'utf8',
    ))
    this._writeTail = write.catch((error) => {
      this._writeError ??= error
    })
    return write.then(() => undefined, () => undefined)
  }

  flush(): Promise<number> {
    return this._run(async () => {
      await this._ensureLoaded()
      await this._drainWrite()
      if (this._writeError) {
        const error = this._writeError
        this._writeError = undefined
        throw error
      }
      const seq = this._nextSeq - 1
      this._broadcast?.('flush', { file: this.file, seq })
      return seq
    })
  }

  async lineage(messageId: string): Promise<SessionEvent[]> {
    return this._run(async () => {
      await this._ensureLoaded()
      return this._resolveLineage(messageId)
    })
  }

  /** The next turn number: one more than the highest recorded `turn/start`. */
  async nextTurn(): Promise<number> {
    return this._run(async () => {
      await this._ensureLoaded()
      let max = 0
      for (const event of this._events) {
        if (event.type === 'turn/start') max = Math.max(max, event.payload.turn)
      }
      return max + 1
    })
  }

  async forkAt(messageId: string): Promise<SessionEvent[]> {
    return this._run(async () => {
      await this._ensureLoaded()
      const lineage = this._resolveLineage(messageId)
      const lineageIds = new Set(lineage.map(event => event.id))
      const targetIndex = this._events.findIndex(
        event => event.id === messageId && isMessageEvent(event),
      )
      if (targetIndex < 0) {
        throw new Error(`message not found: ${messageId}`)
      }
      const selected: SessionEvent[] = []
      let skippedMessage = false
      for (let index = 0; index <= targetIndex; index += 1) {
        const event = this._events[index]!
        if (isMessageEvent(event)) {
          if (!lineageIds.has(event.id)) {
            skippedMessage = true
            continue
          }
          skippedMessage = false
          selected.push(clone(event))
          continue
        }
        if (
          event.type === 'meta'
          || event.type === 'llm/retry'
          || event.type === 'llm/retry-started'
          // Message forks omit the owning lifecycle, including its attempt ledger.
          || event.type === 'assistant/attempt'
          || event.type.startsWith('turn/')
          || event.type.startsWith('step/')
        ) {
          continue
        }
        if (event.type === 'checkpoint') {
          selected.push(clone(event))
          continue
        }
        if (!skippedMessage) {
          selected.push(clone(event))
        }
      }
      return selected
    })
  }

  read(): Promise<SessionEvent[]> {
    return this._run(async () => {
      await this._ensureLoaded()
      return this._events.map(event => clone(event))
    })
  }

  deriveMessages(): Promise<ModelMessage[]> {
    return this._run(async () => {
      await this._ensureLoaded()
      return clone(this._surface)
    })
  }

  /** The ordered surface events, after compaction replacements are applied. */
  surfaceEvents(): Promise<SessionEvent[]> {
    return this._run(async () => {
      await this._ensureLoaded()
      const bySeq = new Map(this._events.map(event => [event.seq, event] as const))
      return this._surfaceNodes
        .map(seq => bySeq.get(seq))
        .filter((event): event is SessionEvent => event !== undefined)
        .map(event => clone(event))
    })
  }

  /** The latest `request/header` snapshot, or undefined before the first one. */
  requestHeader(): RequestHeaderPayload | undefined {
    return this._requestHeader ? clone(this._requestHeader) : undefined
  }

  /** The latest resolved route metadata, or undefined before the first one. */
  requestContext(): RequestContextPayload | undefined {
    return this._requestContext ? clone(this._requestContext) : undefined
  }

  /** Display metadata folded from the durable `meta` + `meta/patch` events. */
  meta(): Promise<{ title?: string; agentType?: AgentType; mode?: SessionMode }> {
    return this._run(async () => {
      await this._ensureLoaded()
      return foldSessionMeta(this._events)
    })
  }

  estimateContext(limit = DEFAULT_CONTEXT_LIMIT): Promise<ContextUsage> {
    return this._run(async () => {
      await this._ensureLoaded()
      return estimateContextUsage(this._surface, limit)
    })
  }

  replay(): Promise<SessionEvent[]>
  replay<T>(reduce: ReplayReducer<T>, initial: T): Promise<T>
  replay<T>(reduce?: ReplayReducer<T>, initial?: T): Promise<SessionEvent[] | T> {
    return this.read().then((events) => {
      if (!reduce) return events
      let state = initial as T
      let pending: Promise<void> = Promise.resolve()
      for (const event of events) {
        pending = pending.then(async () => {
          state = await reduce(state, event)
        })
      }
      return pending.then(() => state)
    })
  }

  /** Structural violations in the loaded event stream (empty = balanced). */
  runInvariants(): Promise<SessionInvariantFailure[]> {
    return this._run(async () => {
      await this._ensureLoaded()
      return checkSessionInvariants(this._events)
    })
  }

  /**
   * Compact the session without ever rewriting history.
   *
   * The surface (not the raw log) is the unit of compaction. A kept suffix —
   * measured in tokens via `keepTokens`, or in nodes via `keep`, and always
   * snapped to start on a fresh `user/message` turn so a tool result never
   * outlives the assistant call it answers — stays visible; every earlier
   * surface node is shadowed by the checkpoint's `surfaceOp.replace` range.
   * The three compaction events are appended like any other event, so seqs
   * stay immutable, live observers see the transition, and a crash can only
   * leave an orphaned `compaction/start` rather than a torn rewrite.
   *
   * Returns the new event count, or the unchanged count when there is no
   * useful surface span to shadow.
   */
  compact(options: CompactOptions = {}): Promise<number> {
    return this._run(async () => {
      await this._ensureLoaded()
      const events = this._events
      const bySeq = new Map(events.map(event => [event.seq, event] as const))
      const surfaceEvents = foldSurface(events).nodes
        .map(seq => bySeq.get(seq))
        .filter((event): event is SessionEvent => event !== undefined)

      const keep = resolveCompactKeep(surfaceEvents, options)
      let split = Math.max(0, surfaceEvents.length - keep)
      // The retained tail must open on a fresh user turn: shadowing an
      // assistant step while keeping its tool results would leave an orphan
      // tool message at the head of the transcript. Prefer the next user
      // boundary; when the candidate sits inside the final turn, keep that
      // whole turn instead of cutting it.
      if (split < surfaceEvents.length && surfaceEvents[split]!.type !== 'user/message') {
        let next = split
        while (next < surfaceEvents.length && surfaceEvents[next]!.type !== 'user/message') next += 1
        if (next < surfaceEvents.length) {
          split = next
        } else {
          let lastUser = surfaceEvents.length - 1
          while (lastUser >= 0 && surfaceEvents[lastUser]!.type !== 'user/message') lastUser -= 1
          split = lastUser >= 0 ? lastUser : surfaceEvents.length
        }
      }
      const shadowed = surfaceEvents.slice(0, split)
      if (!options.messages?.length) return this._events.length

      // A compaction needs a summary to write. When there is history to
      // shadow the checkpoint replaces that head span; when there is none (a
      // budget trip before anything is durable) the checkpoint seeds the
      // surface with the compacted prefix instead.
      const range = shadowed.length
        ? { start: shadowed[0]!.seq, end: shadowed[shadowed.length - 1]!.seq }
        : undefined
      const boundary = split
      this._commitEvent(this._buildEvent('compaction/start', {
        ...(boundary > 0 ? { boundary } : {}),
        ...(options.keep !== undefined ? { keep: options.keep } : {}),
        ...(options.tokensBefore !== undefined ? { tokensBefore: options.tokensBefore } : {}),
      }))
      const checkpoint = this._buildEvent('checkpoint', {
        messages: clone(options.messages),
        ...(range ? { surfaceOp: { op: 'replace', start: range.start, end: range.end } } : {}),
        ...(options.summary ? { summary: options.summary } : {}),
        ...(options.tokensBefore !== undefined ? { tokensBefore: options.tokensBefore } : {}),
      })
      this._commitEvent(checkpoint)
      this._commitEvent(this._buildEvent('compaction/end', {
        checkpointId: checkpoint.id,
        ...(options.keep !== undefined ? { keep: options.keep } : {}),
      }))
      return this._events.length
    })
  }

  close(): Promise<void> {
    return this._queue.then(async () => {
      await this._drainWrite()
      if (this._writeError) {
        const error = this._writeError
        this._writeError = undefined
        throw error
      }
      const key = sessionFileKey(this.file)
      if (liveSessions.get(key) === this) liveSessions.delete(key)
    })
  }

  private _run<T>(task: () => Promise<T>): Promise<T> {
    const next = this._queue.then(task, task)
    this._queue = next.then(() => undefined, () => undefined)
    return next
  }

  private async _ensureLoaded(): Promise<void> {
    if (this._loaded) return
    const key = sessionFileKey(this.file)
    const owner = liveSessions.get(key)
    if (owner && owner !== this && owner._loaded) {
      this._events = owner._events.map(event => clone(event))
      this._surface = clone(owner._surface)
      this._surfaceNodes = [...owner._surfaceNodes]
      this._requestHeader = owner._requestHeader ? clone(owner._requestHeader) : undefined
      this._requestContext = owner._requestContext ? clone(owner._requestContext) : undefined
      this._nextSeq = owner._nextSeq
      this._loaded = true
      return
    }
    await mkdir(dirname(resolve(this.file)), { recursive: true })
    const read = await this._read()
    if (!read.existing) {
      const meta: SessionEvent = {
        id: randomUUID(),
        seq: 1,
        ts: Date.now(),
        type: 'meta',
        payload: { formatVersion: SESSION_FORMAT_VERSION },
      }
      await writeFile(this.file, `${JSON.stringify(meta)}\n`, 'utf8')
      this._events = [meta]
      this._refreshSurface()
      this._nextSeq = 2
      this._loaded = true
      return
    }
    this._events = read.events
    this._refreshSurface()
    this._requestHeader = foldRequestHeader(this._events)
    this._requestContext = foldRequestContext(this._events)
    this._nextSeq = (this._events.at(-1)?.seq ?? 0) + 1
    this._loaded = true
  }

  private async _read(): Promise<{ existing: boolean; events: SessionEvent[] }> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { existing: false, events: [] }
      }
      throw error
    }
    if (!text.trim()) return { existing: false, events: [] }

    const lines = text.split('\n')
    const events: SessionEvent[] = []
    let torn = false
    for (const line of lines) {
      if (!line.trim()) continue
      if (torn) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        torn = true
        continue
      }
      if (!isSessionEvent(parsed)) {
        torn = true
        continue
      }
      events.push(parsed)
    }

    this._assertFormat(events)

    const key = sessionFileKey(this.file)
    const owner = liveSessions.get(key)
    if (owner && owner !== this) {
      // A live writer owns this log; never synthesize closures over its active turn.
      return { existing: true, events }
    }

    const synthetic = repairUnclosed(events)
    if (!torn && !synthetic.length) return { existing: true, events }

    const repaired = [...events, ...synthetic]
    await writeFile(
      this.file,
      `${repaired.map(event => JSON.stringify(event)).join('\n')}\n`,
      'utf8',
    )
    return { existing: true, events: repaired }
  }

  private _assertFormat(events: readonly SessionEvent[]): void {
    let version: number | undefined
    for (const event of events) {
      if (event.type !== 'meta') continue
      const value = (event.payload as Record<string, unknown>).formatVersion
      if (typeof value === 'number') version = value
    }
    if (version === undefined) {
      throw new SessionFormatError(
        `session log is missing formatVersion; expected ${SESSION_FORMAT_VERSION}`,
      )
    }
    if (version !== SESSION_FORMAT_VERSION) {
      throw new SessionFormatError(
        `unsupported session format version ${version}; expected ${SESSION_FORMAT_VERSION}`,
      )
    }
  }

  private _resolveLineage(messageId: string): SessionEvent[] {
    const messages = this._events.filter(
      (event): event is Extract<SessionEvent, { type: MessageEventType }> => isMessageEvent(event),
    )
    const byId = new Map<string, Extract<SessionEvent, { type: MessageEventType }>>(
      messages.map(event => [event.id, event] as const),
    )
    if (!byId.has(messageId)) {
      throw new Error(`message not found: ${messageId}`)
    }
    const chain: SessionEvent[] = []
    const seen = new Set<string>()
    let cursorId: string | undefined = messageId
    while (cursorId && byId.has(cursorId) && !seen.has(cursorId)) {
      seen.add(cursorId)
      const event: Extract<SessionEvent, { type: MessageEventType }> = byId.get(cursorId)!
      chain.unshift(clone(event))
      const parentId: string | undefined = event.payload.parentId
      if (parentId && byId.has(parentId)) {
        cursorId = parentId
        continue
      }
      const index = messages.findIndex(message => message.id === cursorId)
      cursorId = index > 0 ? messages[index - 1]!.id : undefined
    }
    return chain
  }
}

export const session = {
  name: 'session',
  apply: async (ctx: Context, config: SessionConfig) => {
    const log = new SessionLog(config.file, config.broadcast ?? ((type, payload) => {
      if (type === 'event') ctx.emit('session/event', payload)
      else ctx.emit('session/flush', payload)
    }))
    await log.init()
    ctx.provide('session', log)
    return () => log.close()
  },
}

export * from './invariant.js'

export const name = '@tnega/session'
