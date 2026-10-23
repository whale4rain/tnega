import { Service, type Context } from '@tnega/core'
import { renderToolResult, type SessionEvent } from '@tnega/session'

declare module '@tnega/core' {
  interface ServiceMap {
    sessionSearch: SessionSearchService
  }
}

/** One session, named by the workspace it belongs to and its id. */
export interface SessionRef {
  workspace: string
  sessionId: string
}

/** What part of a session a piece of text came from. */
export type SessionTextKind = 'title' | 'user' | 'assistant' | 'tool-call' | 'tool-result'

export interface SessionSearchRequest {
  query: string
  /** Only sessions of these workspaces are searched. */
  workspaces: readonly string[]
  /** Left out of the results: the session that is asking. */
  excludeSessionId?: string
  limit: number
}

export interface SessionMatch extends SessionRef {
  title: string
  updatedAt: number
  /** How many pieces of the session matched. */
  matches: number
  /** The best match, with the matched text wrapped in `**`. */
  snippet: string
  /** The event the best match came from; 0 for the title. */
  seq: number
  kind: SessionTextKind
}

export interface SessionSearchResult {
  sessions: SessionMatch[]
  /** More sessions matched than `limit`. */
  capped: boolean
}

export interface SessionEventSearchRequest {
  session: SessionRef
  query: string
  limit: number
}

export interface SessionEventMatch {
  seq: number
  ts: number
  kind: SessionTextKind
  snippet: string
}

export interface SessionEventSearchResult {
  title: string
  /** The best matches, in the order they happened. */
  hits: SessionEventMatch[]
  /** Every match in the session, of which `hits` are the best. */
  total: number
}

export interface SessionReadRequest {
  session: SessionRef
  /** Read the entries around this event. */
  around?: number
  /** Read the entries before this event. */
  before?: number
  limit: number
}

export interface SessionReadEntry {
  seq: number
  ts: number
  kind: Exclude<SessionTextKind, 'title'>
  text: string
}

export interface SessionReadResult {
  title: string
  entries: SessionReadEntry[]
  /** Pass as `before` to read further back. */
  earlierBefore?: number
  /** Pass as `around` to read further on. */
  laterAround?: number
}

export class SessionSearchError extends Error {
  constructor(message: string, readonly code: 'SESSION_NOT_FOUND' | 'SESSION_SEARCH_UNAVAILABLE' | 'SESSION_SEARCH_INVALID') {
    super(message)
    this.name = 'SessionSearchError'
  }
}

/**
 * Service Definition of session history search: owns `ctx.sessionSearch`.
 * A Provider decides how sessions are found (an index, a scan); the model
 * tools are a Consumer. Callers say which workspaces may be searched, so the
 * Provider never decides who may see what.
 *
 * Every call that names one session counts as using it: a Provider that keeps
 * a bounded index keeps the sessions people come back to, and a session named
 * this way is indexed again if it had been dropped.
 */
export abstract class SessionSearchService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sessionSearch')
  }

  /** Sessions whose text matches, best first. */
  abstract searchSessions(request: SessionSearchRequest): Promise<SessionSearchResult>

  /** Matches inside one session. */
  abstract searchEvents(request: SessionEventSearchRequest): Promise<SessionEventSearchResult>

  /** A stretch of one session's conversation, oldest first. */
  abstract read(request: SessionReadRequest): Promise<SessionReadResult>

  /** Which of `workspaces` holds the session `sessionId`, if any. */
  abstract locate(sessionId: string, workspaces: readonly string[]): Promise<SessionRef | undefined>
}

const TOOL_TEXT_CHARS = 2_000

/**
 * The searchable text of one event, or nothing for events people do not read
 * (stream chunks, request headers, bookkeeping). Tool results use
 * `renderToolResult`, the one text the model saw.
 */
export function sessionEventText(event: SessionEvent, maxChars: number): { kind: Exclude<SessionTextKind, 'title'>; text: string } | undefined {
  const cut = (text: string, limit: number): string => {
    const trimmed = text.trim()
    return trimmed.length > limit ? `${trimmed.slice(0, limit)}… [cut, ${trimmed.length} chars]` : trimmed
  }
  let kind: Exclude<SessionTextKind, 'title'>
  let text: string
  switch (event.type) {
    case 'user/message':
      kind = 'user'
      text = cut(event.payload.content, maxChars)
      break
    case 'assistant/message':
      kind = 'assistant'
      text = cut(event.payload.content, maxChars)
      break
    case 'tool/call':
      kind = 'tool-call'
      text = cut(`${event.payload.name} ${event.payload.argRaw ?? JSON.stringify(event.payload.arguments) ?? ''}`, Math.min(maxChars, TOOL_TEXT_CHARS))
      break
    case 'tool/result':
      kind = 'tool-result'
      text = cut(`${event.payload.name}: ${renderToolResult(event.payload)}`, Math.min(maxChars, TOOL_TEXT_CHARS))
      break
    default:
      return undefined
  }
  return text ? { kind, text } : undefined
}

const LINK_PREFIX = 'tnega://session/'

/** A link to a session people can paste into a chat: `tnega://session/<id>?workspace=<path>`. */
export function formatSessionLink(ref: SessionRef): string {
  return `${LINK_PREFIX}${encodeURIComponent(ref.sessionId)}?workspace=${encodeURIComponent(ref.workspace)}`
}

/**
 * Reads a session link, or a bare session id. The workspace is missing when
 * only an id was given.
 */
export function parseSessionLink(text: string): { sessionId: string; workspace?: string } | undefined {
  const value = text.trim()
  if (!value.startsWith(LINK_PREFIX)) return value ? { sessionId: value } : undefined
  const rest = value.slice(LINK_PREFIX.length)
  const query = rest.indexOf('?')
  try {
    const sessionId = decodeURIComponent(query < 0 ? rest : rest.slice(0, query)).replace(/\/+$/, '')
    if (!sessionId) return undefined
    const workspace = query < 0 ? null : new URLSearchParams(rest.slice(query + 1)).get('workspace')
    return workspace ? { sessionId, workspace } : { sessionId }
  } catch {
    return undefined
  }
}

export default SessionSearchService

export const name = '@tnega/session-search'
