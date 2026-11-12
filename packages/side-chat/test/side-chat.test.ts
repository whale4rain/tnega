import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CompleteOptions, LLMAdapter, LLMStreamEvent } from '@tnega/agent'
import { Context } from '@tnega/core'
import { SessionLog, type ModelMessage } from '@tnega/session'
import { createSession, deleteSession, sessionFile, sessionStoreJsonl } from '@tnega/session-store-jsonl'
import { webServer } from '@tnega/web-kit'
import { parseSideTurns, sessionTranscript, sideChatRoutes, sideRequest, type SideChatModelRequest } from '../src/index.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

interface Recorded { messages: readonly ModelMessage[]; options: CompleteOptions; request: SideChatModelRequest }

/** An adapter that streams `reply` in two pieces and records what it was asked. */
function fakeAdapter(reply: string, calls: Recorded[], request: SideChatModelRequest): LLMAdapter {
  return {
    complete: async () => ({ content: reply, finishReason: 'stop' }),
    async *stream(messages, _tools, options): AsyncIterable<LLMStreamEvent> {
      calls.push({ messages, options, request })
      yield { type: 'message_start', id: 'm' }
      yield { type: 'message_delta', id: 'm', delta: reply.slice(0, 3) }
      yield { type: 'message_delta', id: 'm', delta: reply.slice(3) }
      yield { type: 'message_stop', id: 'm', finishReason: 'stop' }
    },
  }
}

async function serve(reply = 'It is fine.'): Promise<{ url: string; calls: Recorded[]; ctx: Context }> {
  const calls: Recorded[] = []
  const ctx = new Context()
  await ctx.plugin(webServer)
  await ctx.plugin(sessionStoreJsonl)
  await ctx.plugin(sideChatRoutes, { resolveAdapter: async (request: SideChatModelRequest) => fakeAdapter(reply, calls, request) })
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://local')
    const match = ctx.webServer.match(req.method ?? 'GET', url.pathname)
    if (match.kind !== 'route') { res.statusCode = 404; res.end(); return }
    void match.handler(req, res, url)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await ctx.fiber.dispose()
  })
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, ctx }
}

async function ask(url: string, workspace: string, body: unknown): Promise<{ status: number; frames: unknown[]; text: string }> {
  const response = await fetch(`${url}/api/side-chat?workspace=${encodeURIComponent(workspace)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  const frames = response.headers.get('content-type')?.startsWith('text/event-stream')
    ? text.split('\n\n').flatMap(frame => {
      const data = frame.split('\n').find(line => line.startsWith('data: '))
      return data ? [JSON.parse(data.slice(6)) as unknown] : []
    })
    : []
  return { status: response.status, frames, text }
}

describe('side chat route', () => {
  it('answers about a session without writing anything to it', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'tnega-side-chat-'))
    const session = await createSession(workspace, { title: 'Parser fix', model: 'flash' })
    cleanups.push(async () => {
      await deleteSession(workspace, session.id)
      await rm(workspace, { recursive: true, force: true })
    })
    const log = new SessionLog(sessionFile(workspace, session.id))
    await log.init()
    await log.append('system/message', { content: 'You are the coding agent.' })
    await log.append('user/message', { content: 'fix the parser in src/parse.ts' })
    await log.append('assistant/message', { content: 'Looking at src/parse.ts now.' })
    await log.close()

    const { url, calls, ctx } = await serve('It is fine.')
    const before = (await ctx.sessionStore.summary(workspace, session.id)).eventCount
    const result = await ask(url, workspace, { session: session.id, messages: [{ role: 'user', content: 'which file is it editing?' }] })

    expect(result.status).toBe(200)
    expect(result.frames).toEqual([
      { type: 'side/delta', text: 'It ' },
      { type: 'side/delta', text: 'is fine.' },
      { type: 'side/done', finishReason: 'stop' },
    ])
    const call = calls[0]!
    expect(call.request).toEqual({ workspace, session: session.id })
    expect(call.options).toMatchObject({ reasoning: 'off' })
    const system = call.messages[0]!.content
    expect(system).toContain('title="Parser fix"')
    expect(system).toContain('[User]: fix the parser in src/parse.ts')
    expect(system).toContain('[Assistant]: Looking at src/parse.ts now.')
    expect(system).not.toContain('You are the coding agent.')
    expect(call.messages.slice(1)).toEqual([{ role: 'user', content: 'which file is it editing?' }])
    expect((await ctx.sessionStore.summary(workspace, session.id)).eventCount).toBe(before)
  })

  it('answers a temporary chat with no session and passes the picked model on', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'tnega-side-chat-'))
    cleanups.push(() => rm(workspace, { recursive: true, force: true }))
    const { url, calls } = await serve('Hi.')
    const result = await ask(url, workspace, {
      model: 'pro',
      messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'Hey.' }, { role: 'user', content: 'again' }],
    })
    expect(result.status).toBe(200)
    expect(calls[0]!.request).toEqual({ workspace, model: 'pro' })
    expect(calls[0]!.messages.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(calls[0]!.messages[0]!.content).not.toContain('<conversation')
  })

  it('refuses bad requests before asking the model', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'tnega-side-chat-'))
    cleanups.push(() => rm(workspace, { recursive: true, force: true }))
    const { url, calls } = await serve()
    expect((await ask(url, workspace, { messages: [] })).status).toBe(400)
    expect((await ask(url, workspace, { messages: [{ role: 'assistant', content: 'x' }] })).status).toBe(400)
    expect((await ask(url, workspace, { session: '../etc', messages: [{ role: 'user', content: 'x' }] })).status).toBe(400)
    expect((await ask(url, workspace, { session: '00000000-0000-4000-8000-000000000000', messages: [{ role: 'user', content: 'x' }] })).status).toBe(404)
    expect(calls).toEqual([])
  })
})

describe('side chat prompt', () => {
  it('keeps the newest part of a long session, from a message boundary', () => {
    const messages: ModelMessage[] = Array.from({ length: 50 }, (_, index) => ({ role: 'user', content: `message ${index} ${'x'.repeat(100)}` }))
    const text = sessionTranscript(messages, 1000)
    expect(text.startsWith('[… earlier messages left out]\n\n[User]: message ')).toBe(true)
    expect(text).toContain('message 49')
    expect(text).not.toContain('message 0 ')
  })

  it('keeps the last 40 side turns and needs a question last', () => {
    const turns = Array.from({ length: 45 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `t${index}` }))
    const parsed = parseSideTurns(turns)
    expect(Array.isArray(parsed) && parsed.length).toBe(40)
    expect(parseSideTurns([{ role: 'system', content: 'x' }])).toMatch(/role/)
    expect(sideRequest([{ role: 'user', content: 'q' }])[0]!.role).toBe('system')
  })
})
