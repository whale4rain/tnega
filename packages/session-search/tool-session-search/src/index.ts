import { resolve } from 'node:path'
import type { Context, Plugin } from '@tnega/core'
import { parseSessionLink, type SessionRef } from '@tnega/session-search'
import type { ToolDefinition, ToolExecuteOptions } from '@tnega/tools'

export const SEARCH_SESSIONS_TOOL_NAME = 'search_sessions'
export const SEARCH_SESSION_TOOL_NAME = 'search_session'
export const READ_SESSION_TOOL_NAME = 'read_session'
export const SESSION_TOOL_NAMES = [SEARCH_SESSIONS_TOOL_NAME, SEARCH_SESSION_TOOL_NAME, READ_SESSION_TOOL_NAME] as const

export interface ToolSessionSearchConfig {
  /**
   * The workspaces whose sessions the agent may search and read: the ones the
   * user sees in the app. Read on every call, so a workspace added while the
   * agent runs is found.
   */
  workspaces: () => readonly string[] | Promise<readonly string[]>
}

const SEARCH_LIMIT = 20
const EVENT_SEARCH_LIMIT = 30
const DEFAULT_READ = 20
const MAX_READ = 100

const SESSION_PARAMETER = {
  type: 'string',
  description: 'The session: a tnega://session/... link the user pasted, or a session id from search_sessions.',
} as const
const WORKSPACE_PARAMETER = {
  type: 'string',
  description: 'The session\'s workspace, when `session` is a bare id. A link already names it.',
} as const

export class SessionToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionToolError'
  }
}

/** Model-facing tools over the user's sessions in every known workspace. Read-only. */
export function toolSessionSearch(config: ToolSessionSearchConfig): Plugin {
  return {
    name: 'tool-session-search',
    inject: ['tools', 'sessionSearch'],
    apply(ctx: Context): void {
      for (const tool of [searchSessionsTool(ctx, config), searchSessionTool(ctx, config), readSessionTool(ctx, config)]) {
        ctx.tools.register(tool)
      }
    },
  }
}

function searchSessionsTool(ctx: Context, config: ToolSessionSearchConfig): ToolDefinition {
  return {
    schema: {
      name: SEARCH_SESSIONS_TOOL_NAME,
      description: 'Search the user\'s earlier tnega sessions, across all their workspaces. Matches titles, messages, tool calls and tool results, ignoring case; every word must appear. Returns sessions best match first, with the number of matches and the best snippet (matched text in **). Leaves out the current session. Then use search_session to find things inside one, or read_session to read it.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, description: 'Words to look for.' },
          workspace: { type: 'string', description: 'Only search this workspace (a path from an earlier result).' },
        },
        required: ['query'],
      },
    },
    metadata: { readOnly: true },
    async execute(input, options) {
      const record = inputRecord(input)
      const query = requiredString(record, 'query')
      const workspaces = await scopedWorkspaces(config, optionalString(record, 'workspace'))
      const result = await ctx.sessionSearch.searchSessions({
        query, workspaces, limit: SEARCH_LIMIT, ...currentSession(options),
      })
      return {
        query,
        sessions: result.sessions.map(session => ({
          session: session.sessionId,
          workspace: session.workspace,
          title: session.title,
          updatedAt: new Date(session.updatedAt).toISOString(),
          matches: session.matches,
          best: { seq: session.seq, kind: session.kind, snippet: session.snippet },
        })),
        ...(result.capped ? { note: `More sessions matched than the ${SEARCH_LIMIT} shown. Add words to narrow the search.` } : {}),
      }
    },
  }
}

function searchSessionTool(ctx: Context, config: ToolSessionSearchConfig): ToolDefinition {
  return {
    schema: {
      name: SEARCH_SESSION_TOOL_NAME,
      description: 'Search inside one earlier session: its messages, tool calls and tool results. Use it when the user points at a session (a tnega://session/... link or an id) or after search_sessions. Returns the best matches in order, each with its seq; pass a seq to read_session as `around` to read what happened there.',
      parameters: {
        type: 'object',
        properties: {
          session: SESSION_PARAMETER,
          workspace: WORKSPACE_PARAMETER,
          query: { type: 'string', minLength: 1, description: 'Words to look for.' },
        },
        required: ['session', 'query'],
      },
    },
    metadata: { readOnly: true },
    async execute(input) {
      const record = inputRecord(input)
      const query = requiredString(record, 'query')
      const session = await sessionRef(ctx, config, record)
      const result = await ctx.sessionSearch.searchEvents({ session, query, limit: EVENT_SEARCH_LIMIT })
      return {
        session: session.sessionId,
        workspace: session.workspace,
        title: result.title,
        total: result.total,
        hits: result.hits.map(hit => ({ seq: hit.seq, at: new Date(hit.ts).toISOString(), kind: hit.kind, snippet: hit.snippet })),
        ...(result.total > result.hits.length ? { note: `Showing the best ${result.hits.length} of ${result.total} matches. Add words to narrow.` } : {}),
      }
    },
  }
}

function readSessionTool(ctx: Context, config: ToolSessionSearchConfig): ToolDefinition {
  return {
    schema: {
      name: READ_SESSION_TOOL_NAME,
      description: 'Read part of an earlier session in order: user and assistant messages, tool calls and tool results, each with its seq. By default the latest entries; pass `around` (a seq from search_session) to read around a match, or `before` to page back. Long entries are cut.',
      parameters: {
        type: 'object',
        properties: {
          session: SESSION_PARAMETER,
          workspace: WORKSPACE_PARAMETER,
          around: { type: 'integer', minimum: 0, description: 'Read the entries around this seq.' },
          before: { type: 'integer', minimum: 0, description: 'Read the entries before this seq.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_READ, description: `How many entries (default ${DEFAULT_READ}).` },
        },
        required: ['session'],
      },
    },
    metadata: { readOnly: true },
    async execute(input) {
      const record = inputRecord(input)
      const session = await sessionRef(ctx, config, record)
      const around = optionalInteger(record, 'around')
      const before = optionalInteger(record, 'before')
      const limit = Math.min(optionalInteger(record, 'limit') ?? DEFAULT_READ, MAX_READ)
      const result = await ctx.sessionSearch.read({
        session, limit: Math.max(1, limit),
        ...(around === undefined ? {} : { around }),
        ...(around === undefined && before !== undefined ? { before } : {}),
      })
      return {
        session: session.sessionId,
        workspace: session.workspace,
        title: result.title,
        entries: result.entries.map(entry => ({ seq: entry.seq, at: new Date(entry.ts).toISOString(), kind: entry.kind, text: entry.text })),
        ...(result.earlierBefore === undefined ? {} : { earlier: `pass before: ${result.earlierBefore} for earlier entries` }),
        ...(result.laterAround === undefined ? {} : { later: `pass around: ${result.laterAround} for later entries` }),
      }
    },
  }
}

/** Finds the session a link or id names, only among the known workspaces. */
async function sessionRef(ctx: Context, config: ToolSessionSearchConfig, record: Record<string, unknown>): Promise<SessionRef> {
  const parsed = parseSessionLink(requiredString(record, 'session'))
  if (!parsed) throw new SessionToolError('session must be a tnega://session/... link or a session id')
  const workspace = parsed.workspace ?? optionalString(record, 'workspace')
  const workspaces = await scopedWorkspaces(config, workspace)
  const found = await ctx.sessionSearch.locate(parsed.sessionId, workspaces)
  if (!found) {
    throw new SessionToolError(workspace
      ? `no session ${parsed.sessionId} in ${workspace}`
      : `no session ${parsed.sessionId} in any known workspace`)
  }
  return found
}

/** The known workspaces, or only `requested` when it is one of them. */
async function scopedWorkspaces(config: ToolSessionSearchConfig, requested: string | undefined): Promise<string[]> {
  const known: string[] = []
  const seen = new Set<string>()
  for (const entry of await config.workspaces()) {
    const workspace = resolve(entry)
    if (seen.has(workspaceKey(workspace))) continue
    seen.add(workspaceKey(workspace))
    known.push(workspace)
  }
  if (requested === undefined) return known
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

/** The agent's own session, left out of search results; runs name agents by their session id. */
function currentSession(options: ToolExecuteOptions): { excludeSessionId?: string } {
  return typeof options.agentId === 'string' ? { excludeSessionId: options.agentId } : {}
}

function inputRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SessionToolError('input must be an object')
  return Object.fromEntries(Object.entries(input))
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || !value.trim()) throw new SessionToolError(`${key} is required`)
  return value.trim()
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function optionalInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

export const name = '@tnega/tool-session-search'
