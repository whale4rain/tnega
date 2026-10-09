import { ApiError, parseSseFrame } from './api'
import type {
  ArtifactFact,
  FactRecord,
  MemoryFact,
  ProjectRecord,
  ProjectSettings,
  ProjectSnapshot,
  ProjectStreamEvent,
  ProjectUsage,
  ResourceFact,
  RoutineFact,
  RoutineSchedule,
  ThreadDetail,
  ThreadRecord,
} from './project-types'

async function call<T>(path: string, workspace: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const url = `${path}${path.includes('?') ? '&' : '?'}${new URLSearchParams({ workspace }).toString()}`
  const response = await fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      'x-tnega-client': '1',
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`.trim()
    let body: unknown
    try {
      body = await response.json()
      const error = (body as { error?: unknown }).error
      if (typeof error === 'string' && error) message = error
    } catch {
      // Keep the status line.
    }
    throw Object.assign(new ApiError(response.status, message), { body })
  }
  return response.json() as Promise<T>
}

/**
 * True when the server does not implement a route yet. Proposed endpoints
 * answer 404 ("unknown project route") or 400/405 on older servers.
 */
export function isUnsupported(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 405 || error.status === 501
    || (error.status === 400 && /archived must be a boolean|unknown project route/.test(error.message)))
}

const base = (id: string) => `/api/projects/${id}`

const replyKey = (projectId: string) => `tnega.replies.${projectId}`

/** Reply links the user chose, kept locally so they survive reloads before the server stores them. */
export function localReplies(projectId: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(replyKey(projectId)) ?? '{}')
    return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {}
  } catch {
    return {}
  }
}

function rememberReply(projectId: string, messageId: string, replyTo: string): void {
  try {
    localStorage.setItem(replyKey(projectId), JSON.stringify({ ...localReplies(projectId), [messageId]: replyTo }))
  } catch {
    // Only affects how the link is shown after a reload.
  }
}

export const projectApi = {
  list: (workspace: string) => call<{ projects: ProjectRecord[] }>('/api/projects', workspace),
  create: (workspace: string, input: { name: string; goal?: string }) =>
    call<{ project: ProjectRecord }>('/api/projects', workspace, { method: 'POST', body: input }),
  snapshot: (workspace: string, id: string) => call<ProjectSnapshot>(base(id), workspace),
  archive: (workspace: string, id: string, archived: boolean) =>
    call<{ project: ProjectRecord }>(base(id), workspace, { method: 'PATCH', body: { archived } }),
  remove: (workspace: string, id: string) => call<{ deleted: boolean }>(base(id), workspace, { method: 'DELETE' }),

  /** `replyTo` is proposed: the server should store it as the envelope's `causationId`. */
  send: async (workspace: string, id: string, text: string, replyTo?: string, interrupt = false) => {
    const receipt = await call<{ messageId: string; createdAt: number }>(`${base(id)}/messages`, workspace, {
      method: 'POST',
      body: { text, ...(replyTo ? { replyTo } : {}), ...(interrupt ? { interrupt: true } : {}) },
    })
    if (replyTo) rememberReply(id, receipt.messageId, replyTo)
    return receipt
  },
  thread: (workspace: string, id: string, threadId: string) =>
    call<ThreadDetail>(`${base(id)}/threads/${threadId}`, workspace),
  sendToThread: (workspace: string, id: string, threadId: string, text: string, interrupt = false) =>
    call<{ messageId: string; createdAt: number }>(`${base(id)}/threads/${threadId}/messages`, workspace, {
      method: 'POST', body: { text, ...(interrupt ? { interrupt: true } : {}) },
    }),
  approve: (workspace: string, id: string, approvalId: string, allow: boolean) =>
    call<{ accepted: boolean }>(`${base(id)}/approvals/${approvalId}`, workspace, { method: 'POST', body: { allow } }),

  addMemory: (workspace: string, id: string, text: string, tags?: string[]) =>
    call<{ record: MemoryFact }>(`${base(id)}/memory`, workspace, { method: 'POST', body: { text, ...(tags?.length ? { tags } : {}) } }),
  editMemory: (workspace: string, id: string, memoryId: string, input: { text: string; expectedVersion: number; tags?: string[] }) =>
    call<{ record: MemoryFact }>(`${base(id)}/memory/${memoryId}`, workspace, {
      method: 'PATCH',
      body: { text: input.text, expected_version: input.expectedVersion, ...(input.tags ? { tags: input.tags } : {}) },
    }),
  deleteMemory: (workspace: string, id: string, memoryId: string, expectedVersion: number) =>
    call<{ record: MemoryFact }>(`${base(id)}/memory/${memoryId}`, workspace, {
      method: 'PATCH',
      body: { deleted: true, expected_version: expectedVersion },
    }),
  memoryHistory: (workspace: string, id: string, memoryId: string) =>
    call<{ history: MemoryFact[] }>(`${base(id)}/memory/${memoryId}`, workspace),

  // --- proposed endpoints (see docs/project/web-contract.md) -------------
  saveSettings: (workspace: string, id: string, patch: { name?: string; goal?: string; settings?: ProjectSettings }) =>
    call<{ project: ProjectRecord }>(base(id), workspace, { method: 'PATCH', body: patch }),
  usage: (workspace: string, id: string, since?: number) =>
    call<ProjectUsage>(`${base(id)}/usage${since !== undefined ? `?since=${Math.floor(since)}` : ''}`, workspace),
  /** A person takes a thread's result (resolved) or reopens it. */
  resolveThread: (workspace: string, id: string, threadId: string, resolved: boolean) =>
    call<{ thread: ThreadRecord }>(`${base(id)}/threads/${threadId}`, workspace, { method: 'PATCH', body: { resolved } }),
  createRoutine: (workspace: string, id: string, input: { title: string; prompt: string; schedule: RoutineSchedule }) =>
    call<{ routine: RoutineFact }>(`${base(id)}/routines`, workspace, { method: 'POST', body: input }),
  updateRoutine: (workspace: string, id: string, routineId: string, patch: { enabled?: boolean; deleted?: boolean; title?: string; prompt?: string; schedule?: RoutineSchedule }) =>
    call<{ routine: RoutineFact }>(`${base(id)}/routines/${routineId}`, workspace, { method: 'PATCH', body: patch }),
  runRoutine: (workspace: string, id: string, routineId: string) =>
    call<{ routine: RoutineFact }>(`${base(id)}/routines/${routineId}/run`, workspace, { method: 'POST', body: {} }),
  /** An artifact's bytes, for documents, slides, sheets, PDFs and images. */
  artifactBlob: async (workspace: string, id: string, hash: string): Promise<Blob> => {
    const response = await fetch(`${base(id)}/artifacts/${hash}?${new URLSearchParams({ workspace }).toString()}`, {
      headers: { 'x-tnega-client': '1' },
    })
    if (!response.ok) throw new ApiError(response.status, `${response.status} ${response.statusText}`)
    return response.blob()
  },
  stopThread: (workspace: string, id: string, threadId: string) =>
    call<{ stopped: boolean }>(`${base(id)}/threads/${threadId}/stop`, workspace, { method: 'POST', body: {} }),
  pause: (workspace: string, id: string) =>
    call<{ stopped: number }>(`${base(id)}/stop`, workspace, { method: 'POST', body: {} }),
  resume: (workspace: string, id: string) =>
    call<{ resumed: boolean }>(`${base(id)}/resume`, workspace, { method: 'POST', body: {} }),
  artifact: async (workspace: string, id: string, hash: string): Promise<string> => {
    const response = await fetch(`${base(id)}/artifacts/${hash}?${new URLSearchParams({ workspace }).toString()}`, {
      headers: { 'x-tnega-client': '1' },
    })
    if (!response.ok) throw new ApiError(response.status, `${response.status} ${response.statusText}`)
    return response.text()
  },
  addToLibrary: (workspace: string, id: string, input: { title: string; content?: string; mediaType?: string; uri?: string; note?: string }) =>
    call<{ record: ArtifactFact | ResourceFact }>(`${base(id)}/library`, workspace, { method: 'POST', body: input }),
}

/**
 * Follow a project's change stream, reconnecting from the last seen message
 * cursor when the connection drops. Returns a function that stops following.
 */
export function followProject(
  workspace: string,
  id: string,
  after: number,
  onEvent: (event: ProjectStreamEvent) => void,
  onConnection?: (connected: boolean) => void,
): () => void {
  const controller = new AbortController()
  let cursor = after
  let retry = 0

  const connect = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      try {
        const query = new URLSearchParams({ workspace, after: String(cursor) })
        const response = await fetch(`${base(id)}/stream?${query.toString()}`, {
          headers: { 'x-tnega-client': '1', accept: 'text/event-stream' },
          signal: controller.signal,
        })
        if (!response.ok || !response.body) throw new ApiError(response.status, 'stream unavailable')
        onConnection?.(true)
        retry = 0
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
        let buffer = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += value
          const frames = buffer.split(/\r?\n\r?\n/)
          buffer = frames.pop() ?? ''
          for (const frame of frames) {
            const event = parseSseFrame(frame) as unknown as ProjectStreamEvent | undefined
            if (!event) continue
            if (event.type === 'snapshot') cursor = event.snapshot.cursor
            else if (event.type === 'message') cursor = Math.max(cursor, event.seq)
            onEvent(event)
          }
        }
      } catch {
        if (controller.signal.aborted) return
      }
      onConnection?.(false)
      retry = Math.min(retry + 1, 5)
      await new Promise(resolve => setTimeout(resolve, 500 * 2 ** retry))
    }
  }
  void connect()
  return () => controller.abort()
}

export type { FactRecord }
