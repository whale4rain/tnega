import { createClient, type SessionDetail, type SessionSummary, type StreamEvent } from '@tnega/client'

export interface Call {
  method: string
  path: string
  body: unknown
}

/**
 * A stand-in for the tnega server behind `createClient`'s `fetch`: canned
 * JSON per route and a scripted SSE stream for `POST /runs`.
 */
export function fakeServer() {
  const calls: Call[] = []
  const summary: SessionSummary = { id: 's1', title: 'First', workspace: '/w', createdAt: 1, updatedAt: 2, eventCount: 0, agentType: 'coding' }
  const state = {
    sessions: [summary] as SessionSummary[],
    detail: { summary, events: [], surface: [], context: { tokens: 0, limit: 0, ratio: 0 }, metrics: { responses: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0 }, running: false } as SessionDetail,
    /** Frames of the next run; the stream waits on `release` before closing when set. */
    run: [] as StreamEvent[],
    release: undefined as Promise<void> | undefined,
    runStatus: 200,
  }
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), 'http://tnega.test')
    const method = init?.method ?? 'GET'
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ method, path: url.pathname, body })
    const path = url.pathname
    if (path === '/api/config') {
      return json({
        apiKeySet: true,
        effective: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', modelId: 'deepseek-chat' },
        config: { apiKeySet: true, path: '/home/.tnega/config.json' },
        env: { apiKeySet: true },
        models: [
          { id: 'deepseek-chat', name: 'DeepSeek Chat', protocol: 'openai', reasoningEfforts: [], apiKeySet: true },
          { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', protocol: 'openai', reasoningEfforts: [], apiKeySet: true },
        ],
      })
    }
    if (path === '/api/workspaces') return json({ path: '/w', workspaces: ['/w'] })
    if (path === '/api/sessions' && method === 'GET') return json({ sessions: state.sessions })
    if (path === '/api/sessions' && method === 'POST') {
      const created = { ...summary, id: 's2', title: '' }
      state.detail = { ...state.detail, summary: created }
      return json({ session: created }, 201)
    }
    const match = /^\/api\/sessions\/([^/]+)(?:\/(.+))?$/.exec(path)
    if (match) {
      const [, id, rest] = match
      if (!rest && method === 'GET') return json({ ...state.detail, summary: { ...state.detail.summary, id } })
      if (!rest && method === 'PATCH') {
        state.detail = { ...state.detail, summary: { ...state.detail.summary, ...(body as object) } }
        return json({ summary: state.detail.summary })
      }
      if (rest === 'questions') return json({ questions: [] })
      if (rest === 'coding/commands') return json({ commands: [{ name: 'review', description: 'Review the diff' }] })
      if (rest === 'steer' || rest?.startsWith('approvals/') || rest === 'stop') return json({ accepted: true, stopped: true })
      if (rest === 'runs') {
        if (state.runStatus !== 200) return json({ error: 'busy' }, state.runStatus)
        const frames = state.run
        const release = state.release
        const encoder = new TextEncoder()
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            for (const frame of frames) controller.enqueue(encoder.encode(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`))
            if (release) await release
            controller.close()
          },
        })
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
    }
    return json({ error: `no route for ${method} ${path}` }, 404)
  }

  const client = createClient({ baseUrl: 'http://tnega.test', fetch: fetch as typeof globalThis.fetch })
  return { client, calls, state }
}

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

/** Resolve once `check` passes, polling the event loop. */
export async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
