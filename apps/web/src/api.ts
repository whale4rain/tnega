import type {
  ConfigSnapshot,
  SessionDetail,
  SessionSummary,
  SlashCommand,
  SlashCommandResult,
  StreamEvent,
} from './types'

const CLIENT_HEADER = { 'x-tnega-client': '1' }

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('x-tnega-client', '1')
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  const response = await fetch(path, { ...init, headers })
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`.trim()
    try {
      const body = await response.json() as { error?: unknown }
      if (typeof body.error === 'string' && body.error) message = body.error
    } catch {
      // keep the status fallback
    }
    throw new ApiError(response.status, message)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export function getConfig(): Promise<ConfigSnapshot> {
  return request('/api/config')
}

export function saveConfig(
  patch: Record<string, unknown>,
): Promise<ConfigSnapshot> {
  return request('/api/config', {
    method: 'PUT',
    body: JSON.stringify(patch),
  })
}

export function listWorkspaces(): Promise<{ workspaces: string[] }> {
  return request('/api/workspaces')
}

export function addWorkspace(path: string): Promise<{
  path: string
  workspaces: string[]
}> {
  return request('/api/workspaces', {
    method: 'POST',
    body: JSON.stringify({ path }),
  })
}

export function removeWorkspace(path: string): Promise<{ workspaces: string[] }> {
  return request('/api/workspaces', {
    method: 'DELETE',
    body: JSON.stringify({ path }),
  })
}

export function listSessions(workspace: string): Promise<{
  workspace: string
  sessions: SessionSummary[]
}> {
  const query = new URLSearchParams({ workspace })
  return request(`/api/sessions?${query.toString()}`)
}

export function createSession(
  workspace: string,
  options: { title?: string; agentType?: 'general' | 'coding'; mode?: 'auto' | 'plan' | 'execute' } = {},
): Promise<{ session: SessionSummary }> {
  const query = new URLSearchParams({ workspace })
  return request(`/api/sessions?${query.toString()}`, {
    method: 'POST',
    body: JSON.stringify({
      ...(options.title !== undefined ? { title: options.title } : {}),
      ...(options.agentType !== undefined ? { agentType: options.agentType } : {}),
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
    }),
  })
}

export function getSession(
  workspace: string,
  id: string,
): Promise<SessionDetail> {
  const query = new URLSearchParams({ workspace })
  return request(`/api/sessions/${id}?${query.toString()}`)
}

export function renameSession(
  workspace: string,
  id: string,
  title: string,
): Promise<{ summary: SessionSummary }> {
  return patchSessionMeta(workspace, id, { title })
}

export function patchSessionMeta(
  workspace: string,
  id: string,
  patch: {
    title?: string
    agentType?: 'general' | 'coding'
    mode?: 'auto' | 'plan' | 'execute'
  },
): Promise<{ summary: SessionSummary }> {
  const query = new URLSearchParams({ workspace })
  return request(`/api/sessions/${id}?${query.toString()}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function codingCommands(
  workspace: string,
  id: string,
): Promise<{
  commands: SlashCommand[]
  agentType: 'general' | 'coding'
  mode: 'auto' | 'plan' | 'execute'
}> {
  const query = new URLSearchParams({ workspace })
  return request(`/api/sessions/${id}/coding/commands?${query.toString()}`)
}

export function codingSlash(
  workspace: string,
  id: string,
  name: string,
  args: string[] = [],
): Promise<{ result: SlashCommandResult }> {
  const query = new URLSearchParams({ workspace })
  return request(`/api/sessions/${id}/coding/slash?${query.toString()}`, {
    method: 'POST',
    body: JSON.stringify({ name, args }),
  })
}

export interface ForkSessionOptions {
  title?: string
  messageId?: string
}

export function forkSession(
  workspace: string,
  id: string,
  options: ForkSessionOptions = {},
): Promise<{ session: SessionSummary }> {
  const query = new URLSearchParams({ workspace })
  return request(`/api/sessions/${id}/fork?${query.toString()}`, {
    method: 'POST',
    body: JSON.stringify(options),
  })
}

export function truncateSession(
  workspace: string,
  id: string,
  messageId: string,
): Promise<{ summary: SessionSummary }> {
  const query = new URLSearchParams({ workspace })
  return request(`/api/sessions/${id}/truncate?${query.toString()}`, {
    method: 'POST',
    body: JSON.stringify({ messageId }),
  })
}

export function compactSession(
  workspace: string,
  id: string,
): Promise<{ summary: SessionSummary }> {
  const query = new URLSearchParams({ workspace })
  return request(`/api/sessions/${id}/compact?${query.toString()}`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

export function stopRun(
  workspace: string,
  id: string,
): Promise<{ stopped: boolean }> {
  const query = new URLSearchParams({ workspace })
  return request(`/api/sessions/${id}/stop?${query.toString()}`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

export function deleteSession(workspace: string, id: string): Promise<void> {
  const query = new URLSearchParams({ workspace })
  return request(`/api/sessions/${id}?${query.toString()}`, {
    method: 'DELETE',
  })
}

export interface RunBody {
  prompt: string
  allowNetwork: boolean
  allowShell: boolean
}

export async function streamRun(
  workspace: string,
  id: string,
  body: RunBody,
  onEvent: (event: StreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const query = new URLSearchParams({ workspace })
  const response = await fetch(
    `/api/sessions/${id}/runs?${query.toString()}`,
    {
      method: 'POST',
      headers: {
        ...CLIENT_HEADER,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal,
    },
  )
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`.trim()
    try {
      const data = await response.json() as { error?: unknown }
      if (typeof data.error === 'string' && data.error) message = data.error
    } catch {
      // keep the status fallback
    }
    throw new ApiError(response.status, message)
  }
  if (!response.body) throw new ApiError(0, 'stream response has no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const frames = buffer.split(/\r?\n\r?\n/)
      buffer = frames.pop() ?? ''
      for (const frame of frames) {
        const event = parseSseFrame(frame)
        if (event) onEvent(event)
      }
    }
    if (buffer.trim()) {
      const event = parseSseFrame(buffer)
      if (event) onEvent(event)
    }
  } finally {
    reader.releaseLock()
  }
}

function parseSseFrame(frame: string): StreamEvent | undefined {
  let eventType = 'message'
  let data = ''
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('event:')) {
      eventType = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      data += line.slice(5).trimStart()
    }
  }
  if (!data) return undefined
  try {
    const parsed = JSON.parse(data) as StreamEvent
    if (!parsed || typeof parsed !== 'object') return undefined
    if (!eventType || eventType === 'message') return parsed
    return { ...parsed, type: eventType } as StreamEvent
  } catch {
    return undefined
  }
}

export function displayPath(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  if (parts.length <= 2) return path
  return `.../${parts.slice(-2).join('/')}`
}

export function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function prettyJson(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
