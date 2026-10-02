/** Client for the Workbench's Changes and Terminal endpoints (see packages/cli/src/changes.ts, terminals.ts). */

export type ChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'

export interface ChangedFile {
  path: string
  status: ChangeStatus
  previousPath?: string
  additions?: number
  deletions?: number
  binary?: boolean
}

export interface ChangeSummary {
  git: boolean
  branch?: string
  files: ChangedFile[]
  truncated?: boolean
}

export interface FileDiff {
  path: string
  status: ChangeStatus
  original?: string | null
  modified?: string | null
  reason?: 'binary' | 'too-large'
}

export interface TerminalInfo {
  id: string
  workspace: string
  title: string
  cols: number
  rows: number
  createdAt: number
  exited?: { code: number }
}

export type TerminalEvent = { type: 'data'; data: string } | { type: 'exit'; code: number }

const HEADERS = { 'x-tnega-client': '1' }

async function call<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const response = await fetch(path, {
    method: init.method ?? 'GET',
    headers: init.body === undefined ? HEADERS : { ...HEADERS, 'content-type': 'application/json' },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
  })
  if (!response.ok) {
    const detail = await response.json().then((value: unknown) => typeof value === 'object' && value ? Reflect.get(value, 'error') : undefined, () => undefined)
    throw new Error(typeof detail === 'string' ? detail : `${response.status} ${response.statusText}`)
  }
  return await response.json() as T
}

function scoped(path: string, workspace: string, extra: Record<string, string> = {}): string {
  return `${path}?${new URLSearchParams({ workspace, ...extra }).toString()}`
}

export const workbenchApi = {
  changes: (workspace: string, signal?: AbortSignal) => call<ChangeSummary>(scoped('/api/changes', workspace), signal ? { signal } : {}),
  diff: (workspace: string, path: string, signal?: AbortSignal) => call<FileDiff>(scoped('/api/changes/file', workspace, { path }), signal ? { signal } : {}),

  terminals: (workspace: string) => call<{ terminals: TerminalInfo[] }>(scoped('/api/terminals', workspace)),
  createTerminal: (workspace: string, cols: number, rows: number) => call<TerminalInfo>(scoped('/api/terminals', workspace), { method: 'POST', body: { cols, rows } }),
  closeTerminal: (id: string) => call<{ ok: true }>(`/api/terminals/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  input: (id: string, data: string) => call<{ ok: true }>(`/api/terminals/${encodeURIComponent(id)}/input`, { method: 'POST', body: { data } }),
  resize: (id: string, cols: number, rows: number) => call<{ ok: true }>(`/api/terminals/${encodeURIComponent(id)}/resize`, { method: 'POST', body: { cols, rows } }),

  /** Scrollback first, then live output, until `signal` aborts or the shell exits. */
  async stream(id: string, onEvent: (event: TerminalEvent) => void, signal: AbortSignal): Promise<void> {
    const response = await fetch(`/api/terminals/${encodeURIComponent(id)}/stream`, { headers: { ...HEADERS, accept: 'text/event-stream' }, signal })
    if (!response.ok || !response.body) throw new Error(`terminal stream: ${response.status}`)
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buffer += value
      const frames = buffer.split(/\r?\n\r?\n/)
      buffer = frames.pop() ?? ''
      for (const frame of frames) {
        const event = parseTerminalFrame(frame)
        if (event) onEvent(event)
      }
    }
  },
}

export function parseTerminalFrame(frame: string): TerminalEvent | undefined {
  const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('')
  if (!data) return undefined
  try {
    const value: unknown = JSON.parse(data)
    if (!value || typeof value !== 'object') return undefined
    const type = Reflect.get(value, 'type')
    if (type === 'data' && typeof Reflect.get(value, 'data') === 'string') return { type, data: String(Reflect.get(value, 'data')) }
    if (type === 'exit' && typeof Reflect.get(value, 'code') === 'number') return { type, code: Number(Reflect.get(value, 'code')) }
  } catch {
    // A torn frame: skip it.
  }
  return undefined
}
