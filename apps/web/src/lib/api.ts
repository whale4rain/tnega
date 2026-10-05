import type {
  ModelRouteInput,
  AgentType,
  ApprovalMode,
  ApprovalReviewerSettings,
  ConfigSnapshot,
  GoalState,
  Permission,
  PendingQuestionRequest,
  QuestionAnswerItem,
  SessionDetail,
  SessionEffort,
  SessionEvent,
  SessionMode,
  SessionSummary,
  SlashCommand,
  SlashResult,
  StreamEvent,
  SubagentEntry,
  ImageAttachment,
} from './types'

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

async function errorFrom(response: Response): Promise<ApiError> {
  let message = `${response.status} ${response.statusText}`.trim()
  try {
    const body = await response.json() as { error?: unknown }
    if (typeof body.error === 'string' && body.error) message = body.error
  } catch {
    // Non-JSON error bodies keep the status line.
  }
  return new ApiError(response.status, message)
}

async function call<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = { 'x-tnega-client': '1' }
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(path, {
    method: init.method ?? 'GET',
    headers,
    signal: init.signal,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })
  if (!response.ok) throw await errorFrom(response)
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

function scoped(path: string, workspace: string, extra?: Record<string, string>): string {
  const query = new URLSearchParams({ workspace, ...extra })
  return `${path}?${query.toString()}`
}

export interface SessionPatch {
  approvalMode?: ApprovalMode
  title?: string
  agentType?: AgentType
  mode?: SessionMode
  model?: string
  reasoningEffort?: SessionEffort
  permission?: Permission
}

export interface ConfigPatch {
  codeMode?: boolean
  /** Shell name or path; empty restores automatic detection. */
  shell?: string
  approvalReview?: ApprovalReviewerSettings & { apiKey?: string }
  apiKey?: string
  baseUrl?: string
  model?: string
  protocol?: '' | 'anthropic' | 'openai'
  reasoningEffort?: '' | 'low' | 'medium' | 'high'
  temperature?: number
}

export interface BackgroundJob {
  id: string
  kind: string
  label: string
  status: 'running' | 'stopping' | 'completed' | 'failed' | 'killed'
  startedAt: number
  finishedAt?: number
  detail?: string
  reported: boolean
  /** Local URLs a background shell process printed. */
  urls?: string[]
  /** The workspace process behind a background shell job. */
  processId?: string
}

export interface BackgroundProcess {
  id: string
  command: string
  cwd: string
  startedAt: number
  pid?: number
  status: BackgroundJob['status']
  exitCode?: number | null
  urls: string[]
}

/** One row of the Files panel tree (`GET /api/files/tree`). */
export interface DirectoryEntry {
  name: string
  path: string
  type: 'dir' | 'file'
  size?: number
}

/** A workspace file opened in the editor; `content` is absent for binary or oversized files. */
export interface TextFile {
  path: string
  content?: string
  reason?: 'binary' | 'too-large'
  size: number
  mtimeMs: number
}

export const api = {
  processes: (workspace: string, signal?: AbortSignal) =>
    call<{ processes: BackgroundProcess[] }>(scoped('/api/processes', workspace), { signal }),
  processOutput: (workspace: string, id: string, signal?: AbortSignal) =>
    call<{ process: BackgroundProcess; output: string; note?: string; hint?: string }>(scoped('/api/processes', workspace, { process_id: id }), { signal }),
  stopProcess: (workspace: string, id: string, signal?: AbortSignal) =>
    call<{ process: BackgroundProcess }>(scoped('/api/processes', workspace), { method: 'POST', body: { process_id: id, action: 'stop' }, signal }),
  config: () => call<ConfigSnapshot>('/api/config'),
  /** Add or replace one chat model route. */
  saveModelRoute: (id: string, input: ModelRouteInput) =>
    call<ConfigSnapshot>(`/api/config/models/${encodeURIComponent(id)}`, { method: 'PUT', body: input }),
  removeModelRoute: (id: string) =>
    call<ConfigSnapshot>(`/api/config/models/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  saveConfig: async (patch: ConfigPatch): Promise<ConfigSnapshot> => {
    const saved = await call<ConfigSnapshot>('/api/config', { method: 'PUT', body: patch })
    if (patch.codeMode !== undefined && saved.config.codeMode !== patch.codeMode) {
      throw new ApiError(409, 'CodeMode 设置未保存：后端没有确认该设置，请重启或更新 Tnega 后端后重试。')
    }
    return saved
  },

  workspaces: () => call<{ workspaces: string[] }>('/api/workspaces'),
  addWorkspace: (path: string) =>
    call<{ path: string; workspaces: string[] }>('/api/workspaces', { method: 'POST', body: { path } }),
  removeWorkspace: (path: string) =>
    call<{ workspaces: string[] }>('/api/workspaces', { method: 'DELETE', body: { path } }),
  pickFolder: async (): Promise<string | undefined> => {
    const desktop = (globalThis as { tnegaDesktop?: { pickFolder?: () => Promise<string | undefined> } }).tnegaDesktop
    if (desktop?.pickFolder) return desktop.pickFolder()
    const result = await call<{ path?: string }>('/api/folder-picker', { method: 'POST', body: {} })
    return result.path
  },

  sessions: (workspace: string) =>
    call<{ sessions: SessionSummary[] }>(scoped('/api/sessions', workspace)),
  createSession: (workspace: string, init: { title?: string; agentType?: AgentType; mode?: SessionMode } = {}) =>
    call<{ session: SessionSummary }>(scoped('/api/sessions', workspace), { method: 'POST', body: init }),
  session: (workspace: string, id: string) =>
    call<SessionDetail>(scoped(`/api/sessions/${id}`, workspace)),
  jobs: (workspace: string, id: string, signal?: AbortSignal) =>
    call<{ jobs: BackgroundJob[] }>(scoped(`/api/sessions/${id}/jobs`, workspace), { signal }),
  jobOutput: (workspace: string, id: string, jobId: string, signal?: AbortSignal) =>
    call<{ job: BackgroundJob; output?: string }>(scoped(`/api/sessions/${id}/jobs`, workspace, { job_id: jobId }), { signal }),
  stopJob: (workspace: string, id: string, jobId: string, signal?: AbortSignal) =>
    call<{ job: BackgroundJob }>(scoped(`/api/sessions/${id}/jobs`, workspace), { method: 'POST', body: { job_id: jobId, action: 'stop' }, signal }),
  questions: (workspace: string, id: string, signal?: AbortSignal) =>
    call<{ questions: PendingQuestionRequest[] }>(scoped(`/api/sessions/${id}/questions`, workspace), { signal }),
  answerQuestions: (workspace: string, id: string, requestId: string, answers: QuestionAnswerItem[], signal?: AbortSignal) =>
    call<{ accepted: boolean; resumeQueued?: boolean }>(scoped(`/api/sessions/${id}/questions/${requestId}`, workspace), { method: 'POST', body: { answers }, signal }),
  patchSession: (workspace: string, id: string, patch: SessionPatch) =>
    call<{ summary: SessionSummary }>(scoped(`/api/sessions/${id}`, workspace), { method: 'PATCH', body: patch }),
  deleteSession: (workspace: string, id: string) =>
    call<void>(scoped(`/api/sessions/${id}`, workspace), { method: 'DELETE' }),
  forkSession: (workspace: string, id: string, messageId?: string) =>
    call<{ session: SessionSummary }>(scoped(`/api/sessions/${id}/fork`, workspace), {
      method: 'POST',
      body: messageId ? { messageId } : {},
    }),
  truncate: (workspace: string, id: string, messageId: string) =>
    call<{ summary: SessionSummary }>(scoped(`/api/sessions/${id}/truncate`, workspace), {
      method: 'POST',
      body: { messageId },
    }),
  compact: (workspace: string, id: string) =>
    call<{ summary: SessionSummary }>(scoped(`/api/sessions/${id}/compact`, workspace), { method: 'POST', body: {} }),
  stop: (workspace: string, id: string) =>
    call<{ stopped: boolean }>(scoped(`/api/sessions/${id}/stop`, workspace), { method: 'POST', body: {} }),
  approve: (workspace: string, id: string, approvalId: string, allow: boolean) =>
    call<{ accepted: boolean }>(scoped(`/api/sessions/${id}/approvals/${approvalId}`, workspace), {
      method: 'POST',
      body: { allow },
    }),
  goal: (workspace: string, id: string) =>
    call<{ goal: GoalState | null }>(scoped(`/api/sessions/${id}/goal`, workspace)),
  subagents: (workspace: string, id: string) =>
    call<{ subagents: SubagentEntry[] }>(scoped(`/api/sessions/${id}/subagents`, workspace, { scope: 'descendants' })),
  subagent: (workspace: string, id: string) =>
    call<{ id: string; events: SessionEvent[] }>(scoped(`/api/subagents/${id}`, workspace)),

  slashCommands: (workspace: string, id: string) =>
    call<{ commands: SlashCommand[] }>(scoped(`/api/sessions/${id}/coding/commands`, workspace)),
  slashCandidates: (workspace: string, id: string, name: string) =>
    call<{ candidates: Array<{ command: string; args: string[]; label: string; detail?: string }> }>(scoped(`/api/sessions/${id}/coding/slash-candidates`, workspace), {
      method: 'POST',
      body: { name },
    }),
  fileTree: (workspace: string, path: string, signal?: AbortSignal) =>
    call<{ path: string; entries: DirectoryEntry[] }>(scoped('/api/files/tree', workspace, { path }), signal ? { signal } : {}),
  readText: (workspace: string, path: string, signal?: AbortSignal) =>
    call<TextFile>(scoped('/api/files/text', workspace, { path }), signal ? { signal } : {}),
  /** `mtimeMs` is the version the editor loaded; a newer change on disk fails with 409. */
  writeText: (workspace: string, path: string, content: string, mtimeMs?: number) =>
    call<TextFile>(scoped('/api/files/text', workspace, { path }), {
      method: 'PUT',
      body: { content, ...(mtimeMs !== undefined ? { mtimeMs } : {}) },
    }),
  searchFiles: (workspace: string, query: string, signal?: AbortSignal) =>
    call<{ files: string[] }>(scoped('/api/files/search', workspace, { q: query, limit: '30' }), signal ? { signal } : {}),
  runSlash: (workspace: string, id: string, name: string, args: string[]) =>
    call<{ result: SlashResult; mode: SessionMode }>(scoped(`/api/sessions/${id}/coding/slash`, workspace), {
      method: 'POST',
      body: { name, args },
    }),
}

/** Raw bytes of a workspace file the agent produced (office documents, PDFs, images). */
export async function fetchWorkspaceFile(workspace: string, path: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(scoped('/api/files', workspace, { path }), {
    headers: { 'x-tnega-client': '1' },
    ...(signal ? { signal } : {}),
  })
  if (!response.ok) throw await errorFrom(response)
  return response.blob()
}

/** Save a fetched file through the browser's download flow. */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/**
 * Start an Agent Run and feed each SSE frame to `onEvent` until the server
 * closes the stream. Aborting `signal` disconnects, which the server treats
 * as a user cancel.
 */
export async function streamRun(
  workspace: string,
  id: string,
  prompt: string,
  onEvent: (event: StreamEvent) => void,
  signal: AbortSignal,
  resumeQueued = false,
  attachments: readonly ImageAttachment[] = [],
): Promise<void> {
  const response = await fetch(scoped(`/api/sessions/${id}/runs`, workspace), {
    method: 'POST',
    headers: {
      'x-tnega-client': '1',
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body: JSON.stringify(resumeQueued
      ? { resumeQueued: true }
      : { prompt, ...(attachments.length ? { attachments } : {}) }),
    signal,
  })
  if (!response.ok) throw await errorFrom(response)
  if (!response.body) throw new ApiError(0, 'stream response has no body')
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += value
    const frames = buffer.split(/\r?\n\r?\n/)
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const event = parseSseFrame(frame)
      if (event) onEvent(event)
    }
  }
  const tail = parseSseFrame(buffer)
  if (tail) onEvent(tail)
}

export function parseSseFrame(frame: string): StreamEvent | undefined {
  let type: string | undefined
  let data = ''
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('event:')) type = line.slice(6).trim()
    else if (line.startsWith('data:')) data += line.slice(5).trimStart()
  }
  if (!data) return undefined
  try {
    const parsed: unknown = JSON.parse(data)
    if (!parsed || typeof parsed !== 'object') return undefined
    return (type ? { ...parsed, type } : parsed) as StreamEvent
  } catch {
    return undefined
  }
}
