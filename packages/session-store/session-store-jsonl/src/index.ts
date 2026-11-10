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
import { foldApprovalMode, type ApprovalMode } from '@tnega/approval-review'
import {
  SESSION_FORMAT_VERSION,
  SessionLog,
  SessionNotFoundError,
  prepareCompaction,
  type CompactionPreparation,
  foldUsage,
  foldSessionMeta,
  foldSessionPermission,
  type ContextUsage,
  type SessionMetrics,
  type ModelMessage,
  type SessionEvent,
  type SessionPermission,
} from '@tnega/session'
import { importLegacyFile, workspaceSessionDir } from '@tnega/home'
import {
  contextUsageOf,
  forkBody,
  isSessionId,
  metaPatchPayload,
  searchSnippet,
  snapshotFromFolds,
  summaryFromEvents,
  trimStreams,
} from '@tnega/session-store'
import type {
  CreateSessionOptions,
  SessionSearchHit,
  SessionMetaPatch,
  SessionMetaPayload,
  SessionPageOptions,
  SessionSnapshot,
  SessionSummary,
} from '@tnega/session-store'

export type {
  CreateSessionOptions,
  SessionSearchHit,
  SessionMetaPatch,
  SessionMetaPayload,
  SessionPageOptions,
  SessionPageRange,
  SessionSnapshot,
  SessionSummary,
} from '@tnega/session-store'
export { JsonlSessionStore, sessionStoreJsonl } from './store.js'
export { isSessionId }
export { viewEvents } from '@tnega/session-store'

/** A Session the store was asked about but does not have. */
export { SessionNotFoundError }





interface SessionMetaEvent {
  id: string
  seq: number
  ts: number
  type: 'meta'
  payload: SessionMetaPayload & { formatVersion?: number }
}

export function sessionDir(workspace: string): string {
  return workspaceSessionDir(workspace)
}

export function sessionFile(workspace: string, id: string): string {
  if (!isSessionId(id)) throw new TypeError(`invalid session id: ${id}`)
  const target = join(sessionDir(workspace), `${id}.jsonl`)
  importLegacyFile(join(resolve(workspace), '.tnega', 'sessions', `${id}.jsonl`), target)
  return target
}

async function withSessionLog<T>(
  file: string,
  run: (log: SessionLog) => Promise<T>,
  /** A read passes `create: false`: a missing log is reported, not created. */
  options: { create?: boolean } = {},
): Promise<T> {
  // A live writer (a running turn or a resident Agent) owns the sequence.
  const live = SessionLog.live(file)
  if (live) return run(live)
  const log = options.create === false ? SessionLog.readOnly(file) : new SessionLog(file)
  await log.init()
  try {
    return await run(log)
  } finally {
    await log.close()
  }
}

export async function ensureSessionDir(workspace: string): Promise<string> {
  const dir = sessionDir(workspace)
  await mkdir(dir, { recursive: true })
  const legacy = join(resolve(workspace), '.tnega', 'sessions')
  let entries: string[]
  try {
    entries = await readdir(legacy)
  } catch (error) {
    // Missing, or a folder this user cannot read (the server and a box run as
    // different users): no legacy Sessions to import, never a crash.
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'EPERM')) return dir
    throw error
  }
  for (const entry of entries) {
    if (entry.endsWith('.jsonl') && isSessionId(entry.slice(0, -6))) {
      importLegacyFile(join(legacy, entry), join(dir, entry))
    }
  }
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
      formatVersion: SESSION_FORMAT_VERSION,
      ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
      ...(options.forkedAtMessageId ? { forkedAtMessageId: options.forkedAtMessageId } : {}),
      ...(options.agentType ? { agentType: options.agentType } : {}),
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
    },
  }
  const workspaceDir = resolve(workspace)
  await writeFile(sessionFile(workspaceDir, id), `${JSON.stringify(meta)}\n`, 'utf8')
  return {
    id,
    title,
    workspace: workspaceDir,
    createdAt,
    ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
    ...(options.forkedAtMessageId ? { forkedAtMessageId: options.forkedAtMessageId } : {}),
    ...(options.agentType ? { agentType: options.agentType } : {}),
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
    updatedAt: createdAt,
    eventCount: 1,
  }
}

export async function listSessions(workspace: string): Promise<SessionSummary[]> {
  const dir = await ensureSessionDir(workspace)
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

/**
 * Sessions only change by appending, so a summary is cached against the file's
 * identity and recomputed when the file grows. Listing a workspace used to parse
 * every session in full; fifty sessions meant a few seconds of JSON parsing.
 */
const summaryCache = new Map<string, { stamp: string; summary: SessionSummary }>()

/**
 * Only metadata events can change a summary, and they are a small fraction of a
 * log: parsing a tool result (hundreds of bytes, most of the file) cannot affect
 * title, mode, model, permission or approval mode.
 */
function parseMetaLines(lines: readonly string[]): SessionEvent[] {
  const events: SessionEvent[] = []
  for (const line of lines) {
    if (!line.includes('"type":"meta') && !line.includes('"type":"permission/mode"')) continue
    const event = parseSessionEvent(line)
    if (event) events.push(event)
  }
  return events
}

export async function readSessionSummary(
  workspace: string,
  id: string,
): Promise<SessionSummary> {
  const workspaceDir = resolve(workspace)
  const file = sessionFile(workspaceDir, id)
  const fileStat = await stat(file).catch(() => undefined)
  if (!fileStat) return summaryFromEvents(workspaceDir, id, [], 0, Date.now())
  const stamp = `${fileStat.size}:${fileStat.mtimeMs}`
  const cached = summaryCache.get(file)
  if (cached && cached.stamp === stamp) return cached.summary
  const raw = await readEventLines(file)
  const summary = summaryFromEvents(workspaceDir, id, parseMetaLines(raw), raw.length, fileStat.mtimeMs)
  summaryCache.set(file, { stamp, summary })
  return summary
}




/**
 * A session log and its two folds, kept between views. Reopening a session the
 * reader just left is the common case, and re-deriving it costs as much as the
 * first open; the cache is keyed on the file identity so an appended turn
 * misses it. Few entries: a long log is a few MB of parsed events.
 */
interface CachedSessionLog {
  stamp: string
  log: SessionEvent[]
  surface: SessionEvent[]
  messages: Awaited<ReturnType<SessionLog['deriveMessages']>>
}

/** The cached folds keep only the reasoning bounds of each stream copy, so a long log is small enough to keep several. */
const SESSION_LOG_CACHE_SIZE = 8
const sessionLogCache = new Map<string, CachedSessionLog>()

function rememberSessionLog(file: string, cached: CachedSessionLog): void {
  sessionLogCache.delete(file)
  sessionLogCache.set(file, cached)
  while (sessionLogCache.size > SESSION_LOG_CACHE_SIZE) {
    const oldest = sessionLogCache.keys().next().value
    if (oldest === undefined) break
    sessionLogCache.delete(oldest)
  }
}

/**
 * Everything one session view needs, from a single read of its log. The web
 * server used to open the file five times per view and build a whole agent
 * runtime just to read events; on a 5,600-event session that was about half a
 * second of parsing per request, before the runtime.
 *
 * A long history is read a page at a time: the summary and the folds still see
 * the whole log, but only the requested window is sent to the client.
 */
export async function readSessionSnapshot(
  workspace: string,
  id: string,
  windowFor?: (model: string | undefined) => number | undefined,
  pageOptions: SessionPageOptions = {},
): Promise<SessionSnapshot> {
  const workspaceDir = resolve(workspace)
  const file = sessionFile(workspaceDir, id)
  const fileStat = await stat(file).catch(() => undefined)
  const mtimeMs = fileStat?.mtimeMs ?? Date.now()
  const stamp = fileStat ? `${fileStat.size}:${fileStat.mtimeMs}` : undefined
  const cached = stamp === undefined ? undefined : sessionLogCache.get(file)
  const fold = cached && cached.stamp === stamp
    ? cached
    : await withSessionLog(file, async (log) => {
      const fresh: CachedSessionLog = {
        stamp: stamp ?? '',
        // The stream copies are over 90% of a long log and no fold here reads them.
        log: trimStreams(await log.read()),
        surface: trimStreams(await log.surfaceEvents()),
        messages: await log.deriveMessages(),
      }
      if (stamp !== undefined) rememberSessionLog(file, fresh)
      return fresh
    }, { create: false })
  return snapshotFromFolds(workspaceDir, id, fold, mtimeMs, windowFor, pageOptions)
}

export async function setSessionTitle(
  workspace: string,
  id: string,
  title: string,
): Promise<SessionSummary> {
  return patchSessionMeta(workspace, id, { title })
}

/** Persist a Session-level permission choice; no event is needed for a no-op. */
export async function setSessionPermission(
  workspace: string,
  id: string,
  permission: SessionPermission,
): Promise<SessionSummary> {
  const file = sessionFile(workspace, id)
  await withSessionLog(file, async log => {
    if (foldSessionPermission(await log.read()) !== permission) {
      await log.append('permission/mode', { mode: permission })
      await log.flush()
    }
  })
  return readSessionSummary(workspace, id)
}

export async function setSessionApprovalMode(
  workspace: string, id: string, mode: ApprovalMode,
): Promise<SessionSummary> {
  await withSessionLog(sessionFile(workspace, id), async log => {
    if (foldApprovalMode(await log.read()) !== mode) {
      await log.append('meta', { kind: 'approval/mode', mode })
      await log.flush()
    }
  })
  return readSessionSummary(workspace, id)
}

export async function patchSessionMeta(
  workspace: string,
  id: string,
  patch: SessionMetaPatch,
): Promise<SessionSummary> {
  const file = sessionFile(workspace, id)
  const payload = metaPatchPayload(patch)
  if (!payload) return readSessionSummary(workspace, id)
  await withSessionLog(file, async (log) => {
    await log.append('meta/patch', payload)
    await log.flush()
  })
  return readSessionSummary(workspace, id)
}

export async function forkSession(
  workspace: string,
  id: string,
  options: { title?: string; messageId?: string } = {},
): Promise<SessionSummary> {
  const source = sessionFile(workspace, id)
  const { allEvents, events } = await withSessionLog(source, async (log) => {
    const allEvents = await log.read()
    return { allEvents, events: options.messageId ? await log.forkAt(options.messageId) : allEvents }
  }, { create: false })
  const headMeta = allEvents.find(event => event.type === 'meta')
  const createdAt = headMeta && (headMeta.payload as Record<string, unknown>).createdAt
  // A fork is a new session: its head meta carries the source's current
  // metadata (title/agentType/mode folded over the source's meta patches), so
  // the source's meta/patch events need no replay here. A message fork drops
  // the source's meta events, so fold over the whole source log.
  const folded = foldSessionMeta(allEvents)
  const body = forkBody(events)
  const fork = await createSession(workspace, {
    title: options.title?.trim() || `${folded.title ?? 'New session'} fork`,
    ...(typeof createdAt === 'number' ? { createdAt } : {}),
    parentSessionId: id,
    ...(folded.agentType ? { agentType: folded.agentType } : {}),
    ...(folded.mode ? { mode: folded.mode } : {}),
    ...(folded.model ? { model: folded.model } : {}),
    ...(folded.reasoningEffort ? { reasoningEffort: folded.reasoningEffort } : {}),
    ...(options.messageId ? { forkedAtMessageId: options.messageId } : {}),
  })
  if (body.length) {
    const target = sessionFile(workspace, fork.id)
    await writeAtomic(
      target,
      [
        ...(await readEventLines(target)),
        ...body.map(event => JSON.stringify(event)),
      ].join('\n') + '\n',
    )
  }
  return readSessionSummary(workspace, fork.id)
}

export async function truncateSessionAt(
  workspace: string,
  id: string,
  messageId: string,
): Promise<SessionSummary> {
  const file = sessionFile(workspace, id)
  const events = (await readEventLines(file))
    .map(line => parseSessionEvent(line))
    .filter((event): event is SessionEvent => event !== undefined)
  const targetIndex = events.findIndex(
    event => event.id === messageId && event.type === 'user/message',
  )
  if (targetIndex < 0) {
    throw new TypeError(`user message not found: ${messageId}`)
  }
  // Keep every event before the target message in its original order (head
  // meta and meta/patch events stay where they are), so seq stays monotonic
  // and truncation rolls the conversation back to just before that point.
  const next = events
    .slice(0, targetIndex)
    .map(event => JSON.stringify(event))
  await writeAtomic(file, `${next.join('\n')}\n`)
  return readSessionSummary(workspace, id)
}

export async function readSessionMessages(
  workspace: string,
  id: string,
): Promise<ModelMessage[]> {
  return withSessionLog(sessionFile(workspace, id), log => log.deriveMessages(), { create: false })
}

export async function estimateContextUsage(
  workspace: string,
  id: string,
  configuredWindow?: number,
): Promise<ContextUsage> {
  return withSessionLog(sessionFile(workspace, id), async log => {
    const surface = await log.surfaceEvents()
    return contextUsageOf(surface, await log.deriveMessages(), configuredWindow ?? log.requestContext()?.contextWindow)
  }, { create: false })
}

/** Every event of a session's log, for reports that fold over its history. */
export async function readSessionLog(workspace: string, id: string): Promise<SessionEvent[]> {
  return withSessionLog(sessionFile(workspace, id), log => log.read(), { create: false })
}

/**
 * A session's events as they are on disk, without opening the log. Opening a
 * log may repair it (an interrupted tool call gets its result), which a
 * background reader must never do to a session another process is running.
 */
export async function readSessionEventsReadOnly(workspace: string, id: string): Promise<SessionEvent[]> {
  const lines = await readEventLines(sessionFile(resolve(workspace), id))
  const events: SessionEvent[] = []
  for (const line of lines) {
    const event = parseSessionEvent(line)
    if (event) events.push(event)
  }
  return events
}

/** Provider-reported cost and throughput of a session's committed responses. */
export async function readSessionMetrics(
  workspace: string,
  id: string,
): Promise<SessionMetrics> {
  return withSessionLog(sessionFile(workspace, id), async log => foldUsage(await log.read()), { create: false })
}

export interface CompactSessionOptions {
  keep?: number
  keepTokens?: number
  checkpointMessages?: readonly ModelMessage[]
  summary?: string
  tokensBefore?: number
}

export type SessionCompactPreparation = CompactionPreparation

export async function prepareSessionCompact(
  workspace: string,
  id: string,
  keepTokens: number,
): Promise<SessionCompactPreparation> {
  return withSessionLog(sessionFile(workspace, id), log => prepareCompaction(log, keepTokens), { create: false })
}

export async function compactSession(
  workspace: string,
  id: string,
  options: CompactSessionOptions = {},
): Promise<SessionSummary> {
  const file = sessionFile(workspace, id)
  return withSessionLog(file, async (log) => {
    await log.compact({
      ...(options.keep !== undefined ? { keep: options.keep } : {}),
      ...(options.keepTokens !== undefined ? { keepTokens: options.keepTokens } : {}),
      ...(options.checkpointMessages?.length
        ? { messages: [...options.checkpointMessages] }
        : {}),
      ...(options.summary ? { summary: options.summary } : {}),
      ...(options.tokensBefore !== undefined
        ? { tokensBefore: options.tokensBefore }
        : {}),
    })
    await log.flush()
    return readSessionSummary(workspace, id)
  })
}

const SEARCH_MESSAGE_TYPES = ['"type":"user/message"', '"type":"assistant/message"']

/**
 * Finds the sessions whose user or assistant messages contain `query`, ignoring
 * case. Each session reports its latest match once, with a snippet around it.
 * Titles are not searched here: clients already hold them.
 */
export async function searchSessions(
  workspace: string,
  query: string,
  options: { limit?: number } = {},
): Promise<SessionSearchHit[]> {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const limit = options.limit ?? 50
  const dir = await ensureSessionDir(workspace)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  // A line holds the query JSON-escaped; checking that first skips parsing lines that cannot match.
  const escaped = JSON.stringify(needle).slice(1, -1)
  const hits: Array<SessionSearchHit & { at: number }> = []
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue
    const id = entry.slice(0, -'.jsonl'.length)
    if (!isSessionId(id)) continue
    let lines: string[]
    try {
      lines = await readEventLines(join(dir, entry))
    } catch {
      continue
    }
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]!
      if (!SEARCH_MESSAGE_TYPES.some(type => line.includes(type))) continue
      if (!line.toLowerCase().includes(escaped)) continue
      const event = parseSessionEvent(line)
      if (event?.type !== 'user/message' && event?.type !== 'assistant/message') continue
      const snippet = searchSnippet(event.payload.content, needle)
      if (snippet === undefined) continue
      hits.push({ id, snippet, at: event.ts })
      break
    }
  }
  return hits
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map(({ id, snippet }) => ({ id, snippet }))
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

export const name = '@tnega/session-store-jsonl'
