import { resolve } from 'node:path'
import type { Context, Plugin } from '@tnega/core'
import { foldSessionMeta, transcriptEvents } from '@tnega/session'
import {
  isSessionId,
  listSessions,
  readSessionEventsReadOnly,
  searchSessions,
} from '@tnega/session-store'
import type { ToolDefinition } from '@tnega/tools'

export const SEARCH_SESSIONS_TOOL_NAME = 'search_sessions'
export const READ_SESSION_TOOL_NAME = 'read_session'

export interface ToolSessionsConfig {
  /**
   * The workspaces whose sessions the agent may search and read: the same
   * list the user sees in the app. Composition supplies it, so a workspace
   * added while the agent runs is found on the next call.
   */
  workspaces: () => readonly string[] | Promise<readonly string[]>
}

export interface SessionSearchResult {
  workspace: string
  sessionId: string
  title: string
  updatedAt: string
  /** Where the query was found: the title, or a user or assistant message. */
  matched: 'title' | 'message'
  /** A short stretch of the matching message. */
  snippet?: string
}

export interface SessionReadMessage {
  /** Position in the session's conversation, from 0; pass it as `before` to page back. */
  index: number
  role: 'user' | 'assistant'
  at: string
  content: string
}

const DEFAULT_SEARCH_LIMIT = 20
const MAX_SEARCH_LIMIT = 50
const DEFAULT_READ_MESSAGES = 20
const MAX_READ_MESSAGES = 100
const MAX_MESSAGE_CHARS = 4_000

export class SessionToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionToolError'
  }
}

/** Model-facing tools over every known workspace's sessions. Read-only. */
export function toolSessions(config: ToolSessionsConfig): Plugin {
  return {
    name: 'tool-sessions',
    inject: ['tools'],
    apply(ctx: Context): void {
      ctx.tools.register(searchSessionsTool(config))
      ctx.tools.register(readSessionTool(config))
    },
  }
}

function searchSessionsTool(config: ToolSessionsConfig): ToolDefinition {
  return {
    schema: {
      name: SEARCH_SESSIONS_TOOL_NAME,
      description: 'Search the user\'s past tnega sessions across all their workspaces, the same sessions they can search in the app. Matches session titles and the text of user and assistant messages, ignoring case. Returns each matching session once, newest first, with its workspace, session id, title, last update and a snippet. Use read_session to read one. Pass workspace to search only that workspace.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, description: 'Text to look for.' },
          workspace: { type: 'string', description: 'Only search this workspace (an absolute path from a previous result).' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_LIMIT, description: `How many sessions to return (default ${DEFAULT_SEARCH_LIMIT}).` },
        },
        required: ['query'],
      },
    },
    metadata: { readOnly: true },
    async execute(input) {
      const record = inputRecord(input)
      const query = typeof record.query === 'string' ? record.query.trim() : ''
      if (!query) throw new SessionToolError('query is required')
      const limit = boundedCount(record.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT)
      const workspaces = await scopedWorkspaces(config, record.workspace)
      const needle = query.toLowerCase()
      const results: Array<{ updated: number; result: SessionSearchResult }> = []
      for (const workspace of workspaces) {
        let sessions: Awaited<ReturnType<typeof listSessions>>
        let hits: Awaited<ReturnType<typeof searchSessions>>
        try {
          [sessions, hits] = await Promise.all([
            listSessions(workspace),
            searchSessions(workspace, query, { limit: MAX_SEARCH_LIMIT }),
          ])
        } catch {
          // A workspace that is gone or unreadable has nothing to find.
          continue
        }
        const snippets = new Map(hits.map(hit => [hit.id, hit.snippet]))
        for (const session of sessions) {
          const snippet = snippets.get(session.id)
          const titleMatch = session.title.toLowerCase().includes(needle)
          if (!titleMatch && snippet === undefined) continue
          results.push({
            updated: session.updatedAt,
            result: {
              workspace,
              sessionId: session.id,
              title: session.title,
              updatedAt: new Date(session.updatedAt).toISOString(),
              matched: snippet === undefined ? 'title' : 'message',
              ...(snippet === undefined ? {} : { snippet }),
            },
          })
        }
      }
      const sessions = results
        .sort((a, b) => b.updated - a.updated)
        .slice(0, limit)
        .map(entry => entry.result)
      return { query, searchedWorkspaces: workspaces.length, sessions }
    },
  }
}

function readSessionTool(config: ToolSessionsConfig): ToolDefinition {
  return {
    schema: {
      name: READ_SESSION_TOOL_NAME,
      description: 'Read the conversation of one of the user\'s tnega sessions, from any of their workspaces: user and assistant messages in order, oldest first. Returns the latest messages by default; pass before (an index from an earlier read) to page back. Long messages are cut. Use search_sessions first to find the workspace and session id.',
      parameters: {
        type: 'object',
        properties: {
          workspace: { type: 'string', description: 'The session\'s workspace, as search_sessions returned it.' },
          sessionId: { type: 'string', description: 'The session id, as search_sessions returned it.' },
          maxMessages: { type: 'integer', minimum: 1, maximum: MAX_READ_MESSAGES, description: `How many messages to return (default ${DEFAULT_READ_MESSAGES}).` },
          before: { type: 'integer', minimum: 0, description: 'Only return messages before this index.' },
        },
        required: ['workspace', 'sessionId'],
      },
    },
    metadata: { readOnly: true },
    async execute(input) {
      const record = inputRecord(input)
      const sessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : ''
      if (!isSessionId(sessionId)) throw new SessionToolError(`not a session id: ${sessionId || '(empty)'}`)
      if (typeof record.workspace !== 'string' || !record.workspace.trim()) throw new SessionToolError('workspace is required')
      const [workspace] = await scopedWorkspaces(config, record.workspace)
      if (workspace === undefined) throw new SessionToolError(`unknown workspace: ${record.workspace}`)
      const maxMessages = boundedCount(record.maxMessages, DEFAULT_READ_MESSAGES, MAX_READ_MESSAGES)
      // Read the file as it is: opening the log could repair a session another run is writing.
      const events = await readSessionEventsReadOnly(workspace, sessionId)
      if (events.length === 0) throw new SessionToolError(`no session ${sessionId} in ${workspace}`)
      const messages: SessionReadMessage[] = []
      for (const event of transcriptEvents(events)) {
        if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
        const content = event.payload.content.trim()
        if (!content) continue
        messages.push({
          index: messages.length,
          role: event.type === 'user/message' ? 'user' : 'assistant',
          at: new Date(event.ts).toISOString(),
          content: content.length > MAX_MESSAGE_CHARS ? `${content.slice(0, MAX_MESSAGE_CHARS)}… [cut, ${content.length} chars]` : content,
        })
      }
      const end = typeof record.before === 'number' && Number.isInteger(record.before)
        ? Math.max(0, Math.min(record.before, messages.length))
        : messages.length
      const start = Math.max(0, end - maxMessages)
      return {
        workspace,
        sessionId,
        title: foldSessionMeta(events).title ?? 'New session',
        totalMessages: messages.length,
        messages: messages.slice(start, end),
        ...(start > 0 ? { earlier: `${start} earlier messages; pass before: ${start} to read them` } : {}),
      }
    },
  }
}

/** The known workspaces, or only `requested` when it is one of them. */
async function scopedWorkspaces(config: ToolSessionsConfig, requested: unknown): Promise<string[]> {
  const known: string[] = []
  const seen = new Set<string>()
  for (const entry of await config.workspaces()) {
    const workspace = resolve(entry)
    const key = workspaceKey(workspace)
    if (seen.has(key)) continue
    seen.add(key)
    known.push(workspace)
  }
  if (requested === undefined || requested === null || requested === '') return known
  if (typeof requested !== 'string') throw new SessionToolError('workspace must be a path')
  const key = workspaceKey(resolve(requested))
  const match = known.find(workspace => workspaceKey(workspace) === key)
  if (match === undefined) {
    throw new SessionToolError(`unknown workspace: ${requested}. Known workspaces: ${known.join(', ') || '(none)'}`)
  }
  return [match]
}

/** Windows paths compare without case, the same way the session store keys them. */
function workspaceKey(workspace: string): string {
  return process.platform === 'win32' ? workspace.toLowerCase() : workspace
}

function inputRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SessionToolError('input must be an object')
  return input as Record<string, unknown>
}

function boundedCount(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return fallback
  return Math.min(value, max)
}

export const name = '@tnega/tool-sessions'
