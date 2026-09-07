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
  SESSION_FORMAT_VERSION,
  SessionLog,
  estimateContextUsage as estimateSessionContextUsage,
  estimateMessageTokens,
  foldSessionMeta,
  projectEvents,
  safeCompactSplit,
  suffixStartIndexForTokens,
  type ContextUsage,
  type AgentType,
  type MetaPatchPayload,
  type ModelMessage,
  type SessionEvent,
  type SessionMode,
} from '@tnega/session'

export interface SessionMetaPayload {
  title: string
  workspace: string
  createdAt: number
  parentSessionId?: string
  forkedAtMessageId?: string
  agentType?: AgentType
  mode?: SessionMode
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
  agentType?: AgentType
  mode?: SessionMode
}

export interface SessionMetaPatch {
  title?: string
  agentType?: AgentType
  mode?: SessionMode
}

interface SessionMetaEvent {
  id: string
  seq: number
  ts: number
  type: 'meta'
  payload: SessionMetaPayload & { formatVersion?: number }
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

async function withSessionLog<T>(
  file: string,
  run: (log: SessionLog) => Promise<T>,
): Promise<T> {
  const log = new SessionLog(file)
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
  const workspaceDir = resolve(workspace)
  const file = sessionFile(workspaceDir, id)
  const raw = await readEventLines(file)
  const events = raw
    .map(line => parseSessionEvent(line))
    .filter((event): event is SessionEvent => event !== undefined)
  const fileStat = await stat(file)
  const headMeta = events.find(event => event.type === 'meta')
  const headPayload = headMeta?.payload as Record<string, unknown> | undefined
  const createdAt = headPayload && typeof headPayload.createdAt === 'number'
    ? headPayload.createdAt
    : Date.now()
  const folded = foldSessionMeta(events)
  const updatedAt = Math.max(createdAt, fileStat.mtimeMs)
  const summary: SessionSummary = {
    id,
    title: folded.title ?? 'New session',
    workspace: workspaceDir,
    createdAt,
    updatedAt,
    eventCount: raw.length,
  }
  if (folded.agentType) summary.agentType = folded.agentType
  if (folded.mode) summary.mode = folded.mode
  if (headPayload && typeof headPayload.parentSessionId === 'string') {
    summary.parentSessionId = headPayload.parentSessionId
  }
  if (headPayload && typeof headPayload.forkedAtMessageId === 'string') {
    summary.forkedAtMessageId = headPayload.forkedAtMessageId
  }
  return summary
}

export async function setSessionTitle(
  workspace: string,
  id: string,
  title: string,
): Promise<SessionSummary> {
  return patchSessionMeta(workspace, id, { title })
}

export async function patchSessionMeta(
  workspace: string,
  id: string,
  patch: SessionMetaPatch,
): Promise<SessionSummary> {
  const file = sessionFile(workspace, id)
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
  if (!fields.length) return readSessionSummary(workspace, id)
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
  const events = await withSessionLog(source, async (log) => {
    const allEvents = await log.read()
    if (options.messageId) return log.forkAt(options.messageId)
    return allEvents
  })
  const headMeta = events.find(event => event.type === 'meta')
  const createdAt = headMeta && (headMeta.payload as Record<string, unknown>).createdAt
  // A fork is a new session: its head meta carries the source's current
  // metadata (title/agentType/mode folded over the source's meta patches), so
  // the source's meta/patch events need no replay here.
  const folded = foldSessionMeta(events)
  const body = events.filter(event => event.type !== 'meta' && event.type !== 'meta/patch')
  const fork = await createSession(workspace, {
    title: options.title?.trim() || `${folded.title ?? 'New session'} fork`,
    ...(typeof createdAt === 'number' ? { createdAt } : {}),
    parentSessionId: id,
    ...(folded.agentType ? { agentType: folded.agentType } : {}),
    ...(folded.mode ? { mode: folded.mode } : {}),
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
  return withSessionLog(sessionFile(workspace, id), log => log.deriveMessages())
}

export async function estimateContextUsage(
  workspace: string,
  id: string,
): Promise<ContextUsage> {
  const messages = await readSessionMessages(workspace, id)
  return estimateSessionContextUsage(messages)
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
  return withSessionLog(sessionFile(workspace, id), async (log) => {
    const allEvents = await log.read()
    const events = allEvents.filter(event => event.type !== 'meta')
    const suffixStart = suffixStartIndexForTokens(events, keepTokens)
    const split = safeCompactSplit(events, suffixStart)
    const prefix = events.slice(0, split)
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
  })
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
