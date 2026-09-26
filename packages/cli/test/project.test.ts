import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { startWebServer, type WebServer } from '../src/server.js'

const dirs: string[] = []
const servers: WebServer[] = []
const mocks: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
  await Promise.all(mocks.splice(0).map(mock => mock.close()))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, {
    recursive: true, force: true, maxRetries: 10, retryDelay: 50,
  })))
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** 同时应付流式与非流式请求的最小 OpenAI 兼容端点。 */
async function startMockLlm(content: string): Promise<string> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
        stream?: boolean
      }
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'mock-model',
          choices: [{
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: 'stop',
          }],
        }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const chunk of [
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
      ]) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address !== 'object') throw new Error('mock server has no address')
  mocks.push({
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
    }),
  })
  return `http://127.0.0.1:${address.port}/v1`
}

function apiFetch(base: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('x-tnega-client', '1')
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  return fetch(`${base}${path}`, { ...init, headers })
}

interface ProjectSnapshotForTest {
  project: { id: string; name: string }
  coordinatorId: string
  cursor: number
  threads: Array<{ id: string; label: string; state: string; parentId?: string }>
  messages: Array<{ messageId: string; kind: string; text: string; sender: { id: string } }>
}

async function waitForSnapshot(
  base: string,
  workspace: string,
  id: string,
  predicate: (snapshot: ProjectSnapshotForTest) => boolean,
  timeoutMs = 5_000,
): Promise<ProjectSnapshotForTest> {
  const started = Date.now()
  for (;;) {
    const snapshot = await apiFetch(
      base,
      `/api/projects/${id}?workspace=${encodeURIComponent(workspace)}`,
    ).then(response => response.json()) as ProjectSnapshotForTest
    if (predicate(snapshot)) return snapshot
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for project state')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

it('creates a project, runs the main conversation and takes thread notes', async () => {
  const dir = await tempDir('tnega-web-project-')
  const workspace = join(dir, 'workspace')
  await mkdir(workspace, { recursive: true })
  const configFile = join(dir, 'config.json')
  await writeFile(configFile, JSON.stringify({
    apiKey: 'test-key',
    baseUrl: await startMockLlm('notes look good'),
    model: 'mock-model',
    temperature: 0,
  }), 'utf8')
  const server = await startWebServer({ port: 0, host: '127.0.0.1', configFile })
  servers.push(server)
  const query = `?workspace=${encodeURIComponent(workspace)}`

  // 创建只需要一个名称。
  const created = await apiFetch(server.url, `/api/projects${query}`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Notes' }),
  })
  expect(created.status).toBe(200)
  const { project } = await created.json() as { project: { id: string } }
  expect((await apiFetch(server.url, `/api/projects${query}`).then(r => r.json())) as {
    projects: Array<{ id: string }>
  }).toMatchObject({ projects: [{ id: project.id }] })

  // 主对话发言：回执只表示信封落盘，随后协调者的回复自动发布回来。
  const sent = await apiFetch(server.url, `/api/projects/${project.id}/messages${query}`, {
    method: 'POST',
    body: JSON.stringify({ text: 'Summarise the release notes' }),
  })
  expect(sent.status).toBe(200)

  const settled = await waitForSnapshot(server.url, workspace, project.id, snapshot =>
    snapshot.messages.some(entry => entry.kind === 'agent-reply'))
  expect(settled.project.name).toBe('Notes')
  expect(settled.messages.map(entry => entry.kind)).toEqual(['user-message', 'agent-reply'])
  expect(settled.messages[1]).toMatchObject({
    text: 'notes look good',
    sender: { id: settled.coordinatorId },
  })
  expect(settled.threads).toMatchObject([{ id: settled.coordinatorId, state: 'idle' }])
  expect(settled.cursor).toBeGreaterThan(0)

  // 用户直接给协调者 Thread 留言：进入它的 Session，而不是又起一条主对话分支。
  const noted = await apiFetch(
    server.url,
    `/api/projects/${project.id}/threads/${settled.coordinatorId}/messages${query}`,
    { method: 'POST', body: JSON.stringify({ text: 'Keep it under 200 words' }) },
  )
  expect(noted.status).toBe(200)
  const detail = await waitForSnapshot(server.url, workspace, project.id, () => true)
    .then(() => apiFetch(
      server.url,
      `/api/projects/${project.id}/threads/${settled.coordinatorId}${query}`,
    ).then(r => r.json())) as {
      thread: { id: string }
      events: Array<{ type: string; payload: { content?: string } }>
    }
  expect(detail.thread.id).toBe(settled.coordinatorId)
  expect(detail.events.some(event => event.type === 'user/message'
    && event.payload.content === 'Keep it under 200 words')).toBe(true)
  expect(detail.events.some(event => event.type === 'assistant/message')).toBe(true)
})

it('rejects malformed project requests without touching the store', async () => {
  const dir = await tempDir('tnega-web-project-guard-')
  const workspace = join(dir, 'workspace')
  await mkdir(workspace, { recursive: true })
  const configFile = join(dir, 'config.json')
  const server = await startWebServer({ port: 0, host: '127.0.0.1', configFile })
  servers.push(server)

  const missingWorkspace = await apiFetch(server.url, '/api/projects')
  expect(missingWorkspace.status).toBe(400)

  const emptyName = await apiFetch(
    server.url,
    `/api/projects?workspace=${encodeURIComponent(workspace)}`,
    { method: 'POST', body: JSON.stringify({ name: '   ' }) },
  )
  expect(emptyName.status).toBe(400)

  const badId = await apiFetch(
    server.url,
    `/api/projects/not-a-project?workspace=${encodeURIComponent(workspace)}`,
  )
  expect(badId.status).toBe(400)

  const noText = await apiFetch(
    server.url,
    `/api/projects/22222222-2222-4222-8222-222222222222/messages?workspace=${encodeURIComponent(workspace)}`,
    { method: 'POST', body: JSON.stringify({ text: '' }) },
  )
  expect(noText.status).toBe(400)
})

it('creates the folder a project asks for and keeps its data inside', async () => {
  const dir = await tempDir('tnega-web-project-folder-')
  const configFile = join(dir, 'config.json')
  await writeFile(configFile, JSON.stringify({
    apiKey: 'test-key',
    baseUrl: await startMockLlm('noted'),
    model: 'mock-model',
    temperature: 0,
  }), 'utf8')
  const server = await startWebServer({ port: 0, host: '127.0.0.1', configFile })
  servers.push(server)

  // 这个文件夹还不存在：Project 的工作位置是刚为它新建的目录，服务端负责建出来。
  const folder = join(dir, 'release-notes')
  const created = await apiFetch(
    server.url,
    `/api/projects?workspace=${encodeURIComponent(folder)}`,
    { method: 'POST', body: JSON.stringify({ name: 'Release notes' }) },
  )
  expect(created.status).toBe(200)
  const { project } = await created.json() as { project: { id: string } }
  expect(existsSync(join(folder, '.tnega', 'projects', project.id))).toBe(true)

  const listed = await apiFetch(
    server.url,
    `/api/projects?workspace=${encodeURIComponent(folder)}`,
  ).then(response => response.json()) as { projects: Array<{ id: string }> }
  expect(listed.projects.map(entry => entry.id)).toEqual([project.id])
})

it('archives, restores, and permanently deletes a project', async () => {
  const dir = await tempDir('tnega-web-project-lifecycle-')
  const workspace = join(dir, 'workspace')
  await mkdir(workspace, { recursive: true })
  const configFile = join(dir, 'config.json')
  await writeFile(configFile, JSON.stringify({
    apiKey: 'test-key',
    baseUrl: await startMockLlm('ready'),
    model: 'mock-model',
    temperature: 0,
  }), 'utf8')
  const server = await startWebServer({ port: 0, host: '127.0.0.1', configFile })
  servers.push(server)
  const basePath = `/api/projects?workspace=${encodeURIComponent(workspace)}`
  const created = await apiFetch(server.url, basePath, {
    method: 'POST', body: JSON.stringify({ name: 'Lifecycle' }),
  }).then(response => response.json()) as { project: { id: string } }
  const projectPath = join(workspace, '.tnega', 'projects', created.project.id)
  expect(existsSync(projectPath)).toBe(true)

  const projectUrl = `/api/projects/${created.project.id}?workspace=${encodeURIComponent(workspace)}`
  const archived = await apiFetch(server.url, projectUrl, {
    method: 'PATCH', body: JSON.stringify({ archived: true }),
  }).then(response => response.json()) as { project: { archived?: boolean } }
  expect(archived.project.archived).toBe(true)

  const restored = await apiFetch(server.url, projectUrl, {
    method: 'PATCH', body: JSON.stringify({ archived: false }),
  }).then(response => response.json()) as { project: { archived?: boolean } }
  expect(restored.project.archived).toBeUndefined()

  const deleted = await apiFetch(server.url, projectUrl, { method: 'DELETE' })
  expect(deleted.status).toBe(200)
  expect(existsSync(projectPath)).toBe(false)
  const listed = await apiFetch(server.url, basePath).then(response => response.json()) as {
    projects: Array<{ id: string }>
  }
  expect(listed.projects).toEqual([])
})

const FRAME_BREAK = /\r?\n\r?\n/
const LINE_BREAK = /\r?\n/

it('pushes messages that arrive after connecting onto the stream', async () => {
  const dir = await tempDir('tnega-web-project-stream-')
  const workspace = join(dir, 'workspace')
  await mkdir(workspace, { recursive: true })
  const configFile = join(dir, 'config.json')
  await writeFile(configFile, JSON.stringify({
    apiKey: 'test-key',
    baseUrl: await startMockLlm('streamed reply'),
    model: 'mock-model',
    temperature: 0,
  }), 'utf8')
  const server = await startWebServer({ port: 0, host: '127.0.0.1', configFile })
  servers.push(server)
  const query = `?workspace=${encodeURIComponent(workspace)}`

  const { project } = await apiFetch(server.url, `/api/projects${query}`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Streaming' }),
  }).then(response => response.json()) as { project: { id: string } }

  // 先连上，再发言：实时那一条必须和补齐的那一条是同一种帧，否则界面只有刷新才更新。
  const controller = new AbortController()
  const response = await fetch(
    `${server.url}/api/projects/${project.id}/stream${query}&after=0`,
    { headers: { 'x-tnega-client': '1' }, signal: controller.signal },
  )
  expect(response.status).toBe(200)
  const reader = response.body!.getReader()
  const frames: Array<Record<string, unknown>> = []
  const pump = (async () => {
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split(FRAME_BREAK)
        buffer = parts.pop() ?? ''
        for (const part of parts) {
          const data = part.split(LINE_BREAK)
            .filter(entry => entry.startsWith('data:'))
            .map(entry => entry.slice(5).trim())
            .join('')
          if (data) frames.push(JSON.parse(data) as Record<string, unknown>)
        }
      }
    } catch {
      // 中止读取是预期的结束方式。
    }
  })()

  await apiFetch(server.url, `/api/projects/${project.id}/messages${query}`, {
    method: 'POST',
    body: JSON.stringify({ text: 'Summarise the release notes' }),
  })
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline
    && !frames.some(entry => entry.type === 'message'
      && (entry.envelope as { kind?: string }).kind === 'agent-reply')) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  controller.abort()
  await pump

  const kinds = frames.filter(entry => entry.type === 'message')
    .map(entry => (entry.envelope as { kind: string }).kind)
  expect(kinds).toEqual(['user-message', 'agent-reply'])

  // 活的输出：正文按块推、状态跟着变，而不是等整轮结束才知道发生了什么。
  const firstChunk = frames.findIndex(entry => entry.type === 'chunk')
  const reply = frames.findIndex(entry =>
    entry.type === 'message' && (entry.envelope as { kind?: string }).kind === 'agent-reply')
  expect(firstChunk).toBeGreaterThanOrEqual(0)
  expect(firstChunk).toBeLessThan(reply)
  expect(frames.some(entry => entry.type === 'agent-status')).toBe(true)
})
