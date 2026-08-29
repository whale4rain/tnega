import { randomUUID } from 'node:crypto'
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  messageLineage,
  SessionLog,
  projectEvents,
  type ModelMessage,
  type SessionEvent,
} from '@tnega/session'

export interface SessionMetaPayload {
  title: string
  workspace: string
  createdAt: number
  parentSessionId?: string
  forkedAtMessageId?: string
}

export interface SessionSummary extends SessionMetaPayload {
  id: string
  updatedAt: number
  eventCount: number
}

export interface CreateSessionOptions {
  title?: string
  createdAt?: number
  parentSessionId?: string
  forkedAtMessageId?: string
}

interface SessionMetaEvent {
  id: string
  seq: number
  ts: number
  type: 'meta'
  payload: SessionMetaPayload
}

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function sessionDir(workspace: string): string {
  return join(resolve(workspace), '.tnega', 'sessions')
}

export function sessionFile(workspace: string, id: string): string {
  if (!isSessionId(id)) throw new TypeError(`invalid session id: ${id}`)
  return join(sessionDir(workspace), `${id}.jsonl`)
}

export function isSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value)
}

export async function ensureSessionDir(workspace: string): Promise<string> {
  const dir = sessionDir(workspace)
  await mkdir(dir, { recursive: true })
  return dir
}

export async function createSession(
  workspace: string,
  options: CreateSessionOptions = {},
): Promise<SessionSummary> {
  await ensureSessionDir(workspace)
  const id = randomUUID()
  const createdAt = options.createdAt ?? Date.now()
  const title = options.title?.trim() || 'New session'
  const meta: SessionMetaEvent = {
    id,
    seq: 1,
    ts: createdAt,
    type: 'meta',
    payload: {
      title,
      workspace: resolve(workspace),
      createdAt,
      ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
      ...(options.forkedAtMessageId ? { forkedAtMessageId: options.forkedAtMessageId } : {}),
    },
  }
  await writeFile(sessionFile(workspace, id), `${JSON.stringify(meta)}\n`, 'utf8')
  return {
    id,
    ...meta.payload,
    updatedAt: createdAt,
    eventCount: 1,
  }
}

export async function listSessions(workspace: string): Promise<SessionSummary[]> {
  const dir = sessionDir(workspace)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const summaries: SessionSummary[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue
    const id = entry.slice(0, -'.jsonl'.length)
    if (!isSessionId(id)) continue
    try {
      summaries.push(await readSessionSummary(workspace, id))
    } catch {
      // A partially written or invalid session is skipped in listings.
    }
  }
  return summaries.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function readSessionSummary(
  workspace: string,
  id: string,
): Promise<SessionSummary> {
  const file = sessionFile(workspace, id)
  const meta = await readSessionMeta(file)
  const events = await readEventLines(file)
  const fileStat = await stat(file)
  const createdAt = meta.payload.createdAt
  const updatedAt = Math.max(createdAt, fileStat.mtimeMs)
  return {
    id,
    ...meta.payload,
    updatedAt,
    eventCount: events.length,
  }
}

export async function readSessionMeta(file: string): Promise<SessionMetaEvent> {
  const lines = await readEventLines(file)
  for (const line of lines) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (isMetaEvent(parsed)) return parsed
  }
  const now = Date.now()
  const fallback: SessionMetaEvent = {
    id: randomUUID(),
    seq: 1,
    ts: now,
    type: 'meta',
    payload: {
      title: 'New session',
      workspace: '',
      createdAt: now,
    },
  }
  return fallback
}

export async function setSessionTitle(
  workspace: string,
  id: string,
  title: string,
): Promise<SessionSummary> {
  const file = sessionFile(workspace, id)
  const lines = await readEventLines(file)
  const trimmed = title.trim() || 'New session'
  let meta = await readSessionMeta(file)
  meta = {
    ...meta,
    payload: {
      ...meta.payload,
      title: trimmed,
    },
  }
  const next: string[] = [JSON.stringify(meta)]
  for (const line of lines) {
    if (isMetaLine(line)) continue
    next.push(line)
  }
  await writeAtomic(file, `${next.join('\n')}${next.length ? '\n' : ''}`)
  return readSessionSummary(workspace, id)
}

export async function forkSession(
  workspace: string,
  id: string,
  title?: string,
): Promise<SessionSummary> {
  const source = sessionFile(workspace, id)
  const lines = await readEventLines(source)
  const meta = await readSessionMeta(source)
  const fork = await createSession(workspace, {
    title: title?.trim() || `${meta.payload.title} fork`,
    createdAt: meta.payload.createdAt,
    parentSessionId: id,
  })
  const target = sessionFile(workspace, fork.id)
  const forkMeta = await readSessionMeta(target)
  const next = [JSON.stringify(forkMeta), ...lines.filter(line => !isMetaLine(line))]
  await writeAtomic(target, `${next.join('\n')}\n`)
  return readSessionSummary(workspace, fork.id)
}

export async function forkSessionAt(
  workspace: string,
  id: string,
  messageId: string,
  title?: string,
): Promise<SessionSummary> {
  const source = sessionFile(workspace, id)
  const lines = await readEventLines(source)
  const events: SessionEvent[] = []
  for (const line of lines) {
    const event = parseSessionEvent(line)
    if (event) events.push(event)
  }
  const targetIndex = events.findIndex(
    event => event.id === messageId
      && event.type === 'message'
      && event.payload.role === 'user',
  )
  if (targetIndex < 0) {
    throw new TypeError(`user message not found: ${messageId}`)
  }
  const meta = await readSessionMeta(source)
  const fork = await createSession(workspace, {
    title: title?.trim() || `${meta.payload.title} fork`,
    createdAt: meta.payload.createdAt,
    parentSessionId: id,
    forkedAtMessageId: messageId,
  })
  const target = sessionFile(workspace, fork.id)
  const forkMeta = await readSessionMeta(target)
  const startIndex = lineageStartIndex(events, targetIndex)
  const selected = events
    .slice(startIndex, targetIndex + 1)
    .filter(event => event.type !== 'meta')
  const next = [JSON.stringify(forkMeta)]
  selected.forEach((event, index) => {
    next.push(JSON.stringify({ ...event, seq: index + 2 }))
  })
  await writeAtomic(target, `${next.join('\n')}\n`)
  return readSessionSummary(workspace, fork.id)
}

export async function truncateSessionAt(
  workspace: string,
  id: string,
  messageId: string,
): Promise<SessionSummary> {
  const file = sessionFile(workspace, id)
  const lines = await readEventLines(file)
  const events: SessionEvent[] = []
  for (const line of lines) {
    const event = parseSessionEvent(line)
    if (event) events.push(event)
  }
  const targetIndex = events.findIndex(
    event => event.id === messageId
      && event.type === 'message'
      && event.payload.role === 'user',
  )
  if (targetIndex < 0) {
    throw new TypeError(`user message not found: ${messageId}`)
  }
  const meta = await readSessionMeta(file)
  const startIndex = lineageStartIndex(events, targetIndex)
  const next = [
    JSON.stringify(meta),
    ...events
      .slice(startIndex, targetIndex)
      .filter(event => event.type !== 'meta')
      .map(event => JSON.stringify(event)),
  ]
  await writeAtomic(file, `${next.join('\n')}\n`)
  return readSessionSummary(workspace, id)
}

export interface ContextUsage {
  tokens: number
  limit: number
  ratio: number
}

export const DEFAULT_CONTEXT_LIMIT = 128_000

export async function readSessionMessages(
  workspace: string,
  id: string,
): Promise<ModelMessage[]> {
  const log = new SessionLog(sessionFile(workspace, id))
  await log.init()
  return log.deriveMessages()
}

export async function estimateContextUsage(
  workspace: string,
  id: string,
): Promise<ContextUsage> {
  const messages = await readSessionMessages(workspace, id)
  const tokens = estimateMessageTokens(messages)
  const limit = DEFAULT_CONTEXT_LIMIT
  return {
    tokens,
    limit,
    ratio: limit > 0 ? tokens / limit : 0,
  }
}

export interface CompactSessionOptions {
  keep?: number
  keepTokens?: number
  checkpointMessages?: readonly ModelMessage[]
  summary?: string
  tokensBefore?: number
}

export interface SessionCompactPreparation {
  prefixMessages: ModelMessage[]
  previousSummary: string | undefined
  tokensBefore: number
}

export async function prepareSessionCompact(
  workspace: string,
  id: string,
  keepTokens: number,
): Promise<SessionCompactPreparation> {
  const log = new SessionLog(sessionFile(workspace, id))
  await log.init()
  const allEvents = await log.read()
  const events = allEvents.filter(event => event.type !== 'meta')
  const suffixStart = suffixStartIndexForTokens(events, keepTokens)
  const prefix = events.slice(0, suffixStart)
  let previousSummary: string | undefined
  let summaryStart = 0
  for (let index = prefix.length - 1; index >= 0; index -= 1) {
    const event = prefix[index]
    if (
      event?.type === 'checkpoint'
      && typeof event.payload.summary === 'string'
      && event.payload.summary
    ) {
      previousSummary = event.payload.summary
      summaryStart = index + 1
      break
    }
  }
  const tokensBefore = estimateMessageTokens(await log.deriveMessages())
  return {
    prefixMessages: projectEvents(prefix.slice(summaryStart)),
    previousSummary,
    tokensBefore,
  }
}

export async function compactSession(
  workspace: string,
  id: string,
  options: CompactSessionOptions = {},
): Promise<SessionSummary> {
  const file = sessionFile(workspace, id)
  const meta = await readSessionMeta(file)
  const log = new SessionLog(file)
  await log.init()
  const allEvents = await log.read()
  const events = allEvents.filter(event => event.type !== 'meta')
  const keep = resolveCompactKeep(events, options)
  const split = Math.max(0, events.length - keep)
  const prefix = events.slice(0, split)
  const suffix = events.slice(split)
  const checkpointMessages = options.checkpointMessages?.length
    ? [...options.checkpointMessages]
    : projectEvents(prefix)
  const checkpoint: SessionEvent = {
    id: randomUUID(),
    seq: (allEvents.at(-1)?.seq ?? 0) + 1,
    ts: Date.now(),
    type: 'checkpoint',
    payload: {
      messages: checkpointMessages,
      ...(options.summary ? { summary: options.summary } : {}),
      ...(options.tokensBefore !== undefined
        ? { tokensBefore: options.tokensBefore }
        : {}),
      ...(prefix.length ? { snapshot: prefix } : {}),
    },
  }
  const next = [meta, checkpoint, ...suffix]
  await writeAtomic(file, `${next.map(event => JSON.stringify(event)).join('\n')}\n`)
  return readSessionSummary(workspace, id)
}

export async function deleteSession(workspace: string, id: string): Promise<void> {
  await rm(sessionFile(workspace, id), { force: true })
}

export async function ensureWorkspace(value: string): Promise<string> {
  const workspace = resolve(value)
  const info = await stat(workspace)
  if (!info.isDirectory()) throw new TypeError(`not a directory: ${value}`)
  await ensureSessionDir(workspace)
  return workspace
}

async function readEventLines(file: string): Promise<string[]> {
  try {
    const text = await readFile(file, 'utf8')
    return text.split('\n').filter(line => line.trim().length > 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function writeAtomic(file: string, content: string): Promise<void> {
  const target = `${file}.tmp`
  await writeFile(target, content, 'utf8')
  await rename(target, file)
}

function isMetaEvent(value: unknown): value is SessionMetaEvent {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  const payload = record.payload as Record<string, unknown> | undefined
  return record.type === 'meta'
    && typeof payload?.title === 'string'
    && typeof payload.workspace === 'string'
    && typeof payload.createdAt === 'number'
}

function isMetaLine(line: string): boolean {
  try {
    return (JSON.parse(line) as Record<string, unknown>).type === 'meta'
  } catch {
    return false
  }
}

function lineageStartIndex(
  events: readonly SessionEvent[],
  targetIndex: number,
): number {
  const target = events[targetIndex]
  if (!target || target.type !== 'message') return 0
  const lineage = messageLineage(events, target.id)
  if (lineage.length < 2) return 0
  const lineageIds = new Set(lineage.map(event => event.id))
  const start = events.findIndex(
    event => event.type === 'message' && lineageIds.has(event.id),
  )
  return start >= 0 ? start : 0
}

function parseSessionEvent(line: string): SessionEvent | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (
    typeof record.id !== 'string'
    || typeof record.seq !== 'number'
    || typeof record.ts !== 'number'
    || typeof record.type !== 'string'
    || record.payload === undefined
    || record.payload === null
    || typeof record.payload !== 'object'
  ) {
    return undefined
  }
  return value as SessionEvent
}

function estimateMessageTokens(messages: readonly ModelMessage[]): number {
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

function resolveCompactKeep(
  events: readonly SessionEvent[],
  options: CompactSessionOptions,
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

function suffixStartIndexForTokens(
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
    if (event && event.type === 'message' && event.payload.role === 'user') return cut
    cut += 1
  }
  return candidate
}

function estimateEventTokens(event: SessionEvent): number {
  switch (event.type) {
    case 'message':
      return Math.ceil(event.payload.content.length / 4)
    case 'tool-call': {
      const raw = JSON.stringify(event.payload.arguments ?? {}) ?? ''
      return Math.ceil(raw.length / 4)
    }
    case 'tool-result': {
      const raw = event.payload.ok
        ? stringifyUnknown(event.payload.output)
        : event.payload.error?.message ?? 'error'
      return Math.ceil(raw.length / 4)
    }
    case 'checkpoint':
      return estimateMessageTokens(event.payload.messages)
    case 'meta':
      return 0
  }
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}
