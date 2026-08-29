import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startWebServer, type WebServer } from '../src/server.js'

const dirs: string[] = []
const servers: WebServer[] = []
const mockServers: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
  await Promise.all(mockServers.splice(0).map(server => server.close()))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

async function startMockLlm(content: string, delayMs = 0): Promise<{
  url: string
  close: () => Promise<void>
}> {
  const chunks = [
    {
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'mock-model',
      choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
    },
    {
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'mock-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    },
  ]
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => {
      body += String(chunk)
    })
    req.on('end', () => {
      if (typeof body !== 'string') {
        res.writeHead(400)
        res.end('body required')
        return
      }
      const parsed = JSON.parse(body) as { stream?: boolean }
      const respond = (): void => {
        if (parsed.stream !== true) {
          res.writeHead(200, {
            'content-type': 'application/json',
          })
          res.end(JSON.stringify({
            id: 'chatcmpl-mock',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'mock-model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content },
                finish_reason: 'stop',
              },
            ],
          }))
          return
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        })
        for (const chunk of chunks) {
          res.write(`data: ${JSON.stringify(chunk)}\n\n`)
        }
        res.end()
      }
      if (delayMs > 0) {
        const timer = setTimeout(respond, delayMs)
        res.on('close', () => clearTimeout(timer))
      } else {
        respond()
      }
    })
  })
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address !== 'object') throw new Error('mock server has no address')
  const url = `http://127.0.0.1:${address.port}/v1`
  const entry = {
    url,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
    }),
  }
  mockServers.push(entry)
  return entry
}

function apiFetch(
  base: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('x-tnega-client', '1')
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return fetch(`${base}${path}`, { ...init, headers })
}

describe('web server', () => {
  it('enforces client header and serves config without leaking the key', async () => {
    const dir = await tempDir('tnega-web-guard-')
    const configFile = join(dir, 'config.json')
    const server = await startWebServer({ port: 0, host: '127.0.0.1', configFile })
    servers.push(server)

    const forbidden = await fetch(`${server.url}/api/health`)
    expect(forbidden.status).toBe(403)

    const response = await apiFetch(server.url, '/api/config', {
      method: 'PUT',
      body: JSON.stringify({
        apiKey: 'secret-key',
        baseUrl: 'https://example.test/v1',
        model: 'deepseek-v4-pro',
        temperature: 0.4,
      }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    expect(body.apiKeySet).toBe(true)
    expect(JSON.stringify(body)).not.toContain('secret-key')
    const effective = body.effective as Record<string, unknown>
    expect(effective.model).toBe('deepseek-v4-pro')
    expect(effective.temperature).toBe(0.4)
  })

  it('adds workspaces and manages sessions with rename and fork', async () => {
    const dir = await tempDir('tnega-web-store-')
    const workspace = await mkdir(dir, 'workspace')
    const configFile = join(dir, 'config.json')
    const server = await startWebServer({ port: 0, host: '127.0.0.1', configFile })
    servers.push(server)

    const add = await apiFetch(server.url, '/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({ path: workspace }),
    })
    expect(add.status).toBe(200)
    const workspaces = await apiFetch(server.url, '/api/workspaces').then(r => r.json())
    expect(workspaces).toMatchObject({ workspaces: [workspace] })

    const created = await apiFetch(
      server.url,
      `/api/sessions?workspace=${encodeURIComponent(workspace)}`,
      {
        method: 'POST',
        body: JSON.stringify({ title: 'first' }),
      },
    ).then(r => r.json()) as { session: { id: string } }
    const id = created.session.id

    const renamed = await apiFetch(
      server.url,
      `/api/sessions/${id}?workspace=${encodeURIComponent(workspace)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ title: 'renamed' }),
      },
    ).then(r => r.json()) as { summary: { title: string } }
    expect(renamed.summary.title).toBe('renamed')

    const fork = await apiFetch(
      server.url,
      `/api/sessions/${id}/fork?workspace=${encodeURIComponent(workspace)}`,
      { method: 'POST', body: '{}' },
    ).then(r => r.json()) as { session: { id: string; title: string } }
    expect(fork.session.id).not.toBe(id)
    expect(fork.session.title).toBe('renamed fork')

    const removed = await apiFetch(
      server.url,
      `/api/sessions/${id}?workspace=${encodeURIComponent(workspace)}`,
      { method: 'DELETE' },
    )
    expect(removed.status).toBe(204)

    const list = await apiFetch(
      server.url,
      `/api/sessions?workspace=${encodeURIComponent(workspace)}`,
    ).then(r => r.json()) as { sessions: Array<{ id: string }> }
    expect(list.sessions.map(session => session.id)).toEqual([fork.session.id])
  })

  it('forks a session with all history up to the selected user message', async () => {
    const dir = await tempDir('tnega-web-fork-at-')
    const workspace = await mkdir(dir, 'workspace')
    const configFile = join(dir, 'config.json')
    const mock = await startMockLlm('mock reply')
    await writeFile(configFile, JSON.stringify({
      apiKey: 'test-key',
      baseUrl: mock.url,
      model: 'mock-model',
      temperature: 0,
    }), 'utf8')
    const server = await startWebServer({ port: 0, host: '127.0.0.1', configFile })
    servers.push(server)

    const created = await apiFetch(
      server.url,
      `/api/sessions?workspace=${encodeURIComponent(workspace)}`,
      { method: 'POST', body: '{}' },
    ).then(r => r.json()) as { session: { id: string } }
    const id = created.session.id

    async function run(prompt: string): Promise<void> {
      const response = await apiFetch(
        server.url,
        `/api/sessions/${id}/runs?workspace=${encodeURIComponent(workspace)}`,
        {
          method: 'POST',
          body: JSON.stringify({
            prompt,
            allowNetwork: false,
            allowShell: false,
          }),
        },
      )
      expect(response.status).toBe(200)
      await response.text()
      await new Promise(resolve => setTimeout(resolve, 20))
    }

    await run('first turn')
    await run('second turn')

    const detail = await apiFetch(
      server.url,
      `/api/sessions/${id}?workspace=${encodeURIComponent(workspace)}`,
    ).then(r => r.json()) as {
      events: Array<{
        id: string
        type: string
        payload: { role?: string; content?: string; parentId?: string }
      }>
    }
    const messages = detail.events.filter(event => event.type === 'message')
    expect(messages.map(message => message.payload.content)).toEqual([
      'first turn',
      'mock reply',
      'second turn',
      'mock reply',
    ])
    const firstUser = messages.find(message => message.payload.content === 'first turn')!
    const firstAssistant = messages.find(message => message.payload.content === 'mock reply')!
    const secondUser = messages.find(message => message.payload.content === 'second turn')!

    const fork = await apiFetch(
      server.url,
      `/api/sessions/${id}/fork?workspace=${encodeURIComponent(workspace)}`,
      {
        method: 'POST',
        body: JSON.stringify({ messageId: secondUser.id }),
      },
    ).then(r => r.json()) as { session: { id: string } }
    expect(fork.session).toMatchObject({
      parentSessionId: id,
      forkedAtMessageId: secondUser.id,
    })

    const forkDetail = await apiFetch(
      server.url,
      `/api/sessions/${fork.session.id}?workspace=${encodeURIComponent(workspace)}`,
    ).then(r => r.json()) as {
      events: Array<{
        type: string
        payload: { role?: string; content?: string; parentId?: string }
      }>
    }
    const forkMessages = forkDetail.events.filter(event => event.type === 'message')
    expect(forkMessages.map(message => message.payload.content)).toEqual([
      'first turn',
      'mock reply',
      'second turn',
    ])
    expect(forkMessages.map(message => message.payload.parentId)).toEqual([
      undefined,
      firstUser.id,
      firstAssistant.id,
    ])
  })

  it('truncates and resends from a user message', async () => {
    const dir = await tempDir('tnega-web-truncate-')
    const workspace = await mkdir(dir, 'workspace')
    const configFile = join(dir, 'config.json')
    const mock = await startMockLlm('mock reply')
    await writeFile(configFile, JSON.stringify({
      apiKey: 'test-key',
      baseUrl: mock.url,
      model: 'mock-model',
      temperature: 0,
    }), 'utf8')
    const server = await startWebServer({ port: 0, host: '127.0.0.1', configFile })
    servers.push(server)

    const created = await apiFetch(
      server.url,
      `/api/sessions?workspace=${encodeURIComponent(workspace)}`,
      { method: 'POST', body: '{}' },
    ).then(r => r.json()) as { session: { id: string } }
    const id = created.session.id

    async function run(prompt: string): Promise<void> {
      const response = await apiFetch(
        server.url,
        `/api/sessions/${id}/runs?workspace=${encodeURIComponent(workspace)}`,
        {
          method: 'POST',
          body: JSON.stringify({
            prompt,
            allowNetwork: false,
            allowShell: false,
          }),
        },
      )
      expect(response.status).toBe(200)
      await response.text()
      await new Promise(resolve => setTimeout(resolve, 20))
    }

    await run('first turn')
    await run('second turn')

    const detail = await apiFetch(
      server.url,
      `/api/sessions/${id}?workspace=${encodeURIComponent(workspace)}`,
    ).then(r => r.json()) as {
      events: Array<{
        id: string
        type: string
        payload: { role?: string; content?: string }
      }>
    }
    const messages = detail.events.filter(event => event.type === 'message')
    const secondUser = messages.find(message => message.payload.content === 'second turn')!

    const truncated = await apiFetch(
      server.url,
      `/api/sessions/${id}/truncate?workspace=${encodeURIComponent(workspace)}`,
      {
        method: 'POST',
        body: JSON.stringify({ messageId: secondUser.id }),
      },
    )
    expect(truncated.status).toBe(200)

    const after = await apiFetch(
      server.url,
      `/api/sessions/${id}?workspace=${encodeURIComponent(workspace)}`,
    ).then(r => r.json()) as {
      events: Array<{
        type: string
        payload: { role?: string; content?: string }
      }>
    }
    const afterMessages = after.events.filter(event => event.type === 'message')
    expect(afterMessages.map(message => message.payload.content)).toEqual([
      'first turn',
      'mock reply',
    ])

    await run('edited second turn')
    const edited = await apiFetch(
      server.url,
      `/api/sessions/${id}?workspace=${encodeURIComponent(workspace)}`,
    ).then(r => r.json()) as {
      events: Array<{
        type: string
        payload: { role?: string; content?: string }
      }>
    }
    const editedMessages = edited.events.filter(event => event.type === 'message')
    expect(editedMessages.map(message => message.payload.content)).toEqual([
      'first turn',
      'mock reply',
      'edited second turn',
      'mock reply',
    ])
  })

  it('compacts a session into a summarized checkpoint', async () => {
    const dir = await tempDir('tnega-web-compact-')
    const workspace = await mkdir(dir, 'workspace')
    const configFile = join(dir, 'config.json')
    const mock = await startMockLlm('x')
    await writeFile(configFile, JSON.stringify({
      apiKey: 'test-key',
      baseUrl: mock.url,
      model: 'mock-model',
      temperature: 0,
    }), 'utf8')
    const server = await startWebServer({ port: 0, host: '127.0.0.1', configFile })
    servers.push(server)

    const created = await apiFetch(
      server.url,
      `/api/sessions?workspace=${encodeURIComponent(workspace)}`,
      { method: 'POST', body: '{}' },
    ).then(r => r.json()) as { session: { id: string } }
    const id = created.session.id

    const response = await apiFetch(
      server.url,
      `/api/sessions/${id}/runs?workspace=${encodeURIComponent(workspace)}`,
      {
        method: 'POST',
        body: JSON.stringify({
          prompt: 'a very long conversation with lots of words',
          allowNetwork: false,
          allowShell: false,
        }),
      },
    )
    expect(response.status).toBe(200)
    await response.text()
    await new Promise(resolve => setTimeout(resolve, 20))

    const before = await apiFetch(
      server.url,
      `/api/sessions/${id}?workspace=${encodeURIComponent(workspace)}`,
    ).then(r => r.json()) as { context: { tokens: number; ratio: number } }
    expect(before.context.tokens).toBeGreaterThan(0)

    const compact = await apiFetch(
      server.url,
      `/api/sessions/${id}/compact?workspace=${encodeURIComponent(workspace)}`,
      { method: 'POST', body: '{}' },
    )
    expect(compact.status).toBe(200)

    const after = await apiFetch(
      server.url,
      `/api/sessions/${id}?workspace=${encodeURIComponent(workspace)}`,
    ).then(r => r.json()) as {
      context: { tokens: number; ratio: number }
      events: Array<{
        type: string
        payload?: {
          summary?: string
          snapshot?: Array<{
            type: string
            payload?: { role?: string; content?: string }
          }>
        }
      }>
    }
    expect(after.context.tokens).toBeLessThan(before.context.tokens)
    const checkpoint = after.events.find(event => event.type === 'checkpoint')
    expect(checkpoint).toBeDefined()
    expect(typeof checkpoint!.payload?.summary).toBe('string')
    expect(
      checkpoint!.payload?.snapshot?.some(
        event => event.payload?.content === 'a very long conversation with lots of words',
      ),
    ).toBe(true)
  })

  it('keeps recent raw events and a snapshot after compacting a long session', async () => {
    const dir = await tempDir('tnega-web-compact-tail-')
    const workspace = await mkdir(dir, 'workspace')
    const configFile = join(dir, 'config.json')
    const mock = await startMockLlm('tail reply')
    await writeFile(configFile, JSON.stringify({
      apiKey: 'test-key',
      baseUrl: mock.url,
      model: 'mock-model',
      temperature: 0,
    }), 'utf8')
    const server = await startWebServer({ port: 0, host: '127.0.0.1', configFile })
    servers.push(server)

    const created = await apiFetch(
      server.url,
      `/api/sessions?workspace=${encodeURIComponent(workspace)}`,
      { method: 'POST', body: '{}' },
    ).then(r => r.json()) as { session: { id: string } }
    const id = created.session.id

    for (const prompt of ['a'.repeat(80_000), 'b'.repeat(80_000)]) {
      const run = await apiFetch(
        server.url,
        `/api/sessions/${id}/runs?workspace=${encodeURIComponent(workspace)}`,
        {
          method: 'POST',
          body: JSON.stringify({
            prompt,
            allowNetwork: false,
            allowShell: false,
          }),
        },
      )
      expect(run.status).toBe(200)
      await run.text()
      await new Promise(resolve => setTimeout(resolve, 20))
    }

    const second = await apiFetch(
      server.url,
      `/api/sessions/${id}/runs?workspace=${encodeURIComponent(workspace)}`,
      {
        method: 'POST',
        body: JSON.stringify({
          prompt: 'recent request',
          allowNetwork: false,
          allowShell: false,
        }),
      },
    )
    expect(second.status).toBe(200)
    await second.text()
    await new Promise(resolve => setTimeout(resolve, 20))

    const before = await apiFetch(
      server.url,
      `/api/sessions/${id}?workspace=${encodeURIComponent(workspace)}`,
    ).then(r => r.json()) as { context: { tokens: number } }

    const compact = await apiFetch(
      server.url,
      `/api/sessions/${id}/compact?workspace=${encodeURIComponent(workspace)}`,
      { method: 'POST', body: '{}' },
    )
    expect(compact.status).toBe(200)

    const after = await apiFetch(
      server.url,
      `/api/sessions/${id}?workspace=${encodeURIComponent(workspace)}`,
    ).then(r => r.json()) as {
      context: { tokens: number }
      events: Array<{
        type: string
        payload?: {
          content?: string
          snapshot?: Array<{ type: string; payload?: { content?: string } }>
        }
      }>
    }
    expect(after.context.tokens).toBeLessThan(before.context.tokens)
    const checkpointIndex = after.events.findIndex(event => event.type === 'checkpoint')
    expect(checkpointIndex).toBeGreaterThanOrEqual(0)
    const checkpoint = after.events[checkpointIndex]
    expect(checkpoint?.payload?.snapshot?.length).toBeGreaterThan(0)
    const tail = after.events.slice(checkpointIndex + 1).filter(event => event.type === 'message')
    expect(tail.some(event => event.payload?.content === 'recent request')).toBe(true)
  })

  it('streams a run through SSE and persists the final message', async () => {
    const dir = await tempDir('tnega-web-run-')
    const workspace = await mkdir(dir, 'workspace')
    const configFile = join(dir, 'config.json')
    const mock = await startMockLlm('hello from mock')
    await writeFile(configFile, JSON.stringify({
      apiKey: 'test-key',
      baseUrl: mock.url,
      model: 'mock-model',
      temperature: 0,
    }), 'utf8')
    const server = await startWebServer({ port: 0, host: '127.0.0.1', configFile })
    servers.push(server)

    const created = await apiFetch(
      server.url,
      `/api/sessions?workspace=${encodeURIComponent(workspace)}`,
      { method: 'POST', body: '{}' },
    ).then(r => r.json()) as { session: { id: string } }
    const id = created.session.id

    const response = await apiFetch(
      server.url,
      `/api/sessions/${id}/runs?workspace=${encodeURIComponent(workspace)}`,
      {
        method: 'POST',
        body: JSON.stringify({ prompt: 'say hello', allowNetwork: false, allowShell: false }),
      },
    )
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('event: message_start')
    expect(text).toContain('hello from mock')
    expect(text).toContain('event: message_stop')
    expect(text).toContain('event: run/end')
    expect(text).toContain('event: done')

    const detail = await apiFetch(
      server.url,
      `/api/sessions/${id}?workspace=${encodeURIComponent(workspace)}`,
    ).then(r => r.json()) as {
      summary: { title: string }
      events: Array<{ type: string; payload: { role?: string; content?: string } }>
    }
    expect(detail.summary.title).toBe('say hello')
    const messages = detail.events.filter(event => event.type === 'message')
    expect(messages).toHaveLength(2)
    expect(messages[0]!.payload.role).toBe('user')
    expect(messages[1]!.payload.role).toBe('assistant')
    expect(messages[1]!.payload.content).toBe('hello from mock')
  })

  it.skipIf(process.platform !== 'win32')(
    'rejects a concurrent run for the same session when workspace case differs',
    async () => {
      const dir = await tempDir('tnega-web-run-key-')
      const workspace = await mkdir(dir, 'workspace')
      const configFile = join(dir, 'config.json')
      const mock = await startMockLlm('never shown', 500)
      await writeFile(configFile, JSON.stringify({
        apiKey: 'test-key',
        baseUrl: mock.url,
        model: 'mock-model',
        temperature: 0,
      }), 'utf8')
      const server = await startWebServer({ port: 0, host: '127.0.0.1', configFile })
      servers.push(server)

      const created = await apiFetch(
        server.url,
        `/api/sessions?workspace=${encodeURIComponent(workspace)}`,
        { method: 'POST', body: '{}' },
      ).then(r => r.json()) as { session: { id: string } }
      const id = created.session.id

      const firstController = new AbortController()
      const first = await apiFetch(
        server.url,
        `/api/sessions/${id}/runs?workspace=${encodeURIComponent(workspace)}`,
        {
          method: 'POST',
          body: JSON.stringify({
            prompt: 'block',
            allowNetwork: false,
            allowShell: false,
          }),
          signal: firstController.signal,
        },
      )
      expect(first.status).toBe(200)

      const firstChar = workspace.slice(0, 1)
      const mixedWorkspace = `${firstChar === firstChar.toUpperCase()
        ? firstChar.toLowerCase()
        : firstChar.toUpperCase()}${workspace.slice(1)}`
      const second = await apiFetch(
        server.url,
        `/api/sessions/${id}/runs?workspace=${encodeURIComponent(mixedWorkspace)}`,
        {
          method: 'POST',
          body: JSON.stringify({
            prompt: 'blocked',
            allowNetwork: false,
            allowShell: false,
          }),
        },
      )
      expect(second.status).toBe(409)

      await first.text()
    },
  )
})

async function mkdir(parent: string, name: string): Promise<string> {
  const path = join(parent, name)
  await import('node:fs/promises').then(fs => fs.mkdir(path, { recursive: true }))
  return path
}
