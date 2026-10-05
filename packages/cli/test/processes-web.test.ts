import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { startWebServer } from '../src/server.js'

it('keeps a process visible after the run and lets the user read and stop it within its workspace', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'tnega-processes-web-'))
  let requests = 0
  const llm = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      const first = ++requests === 1
      const delta = first ? { tool_calls: [{ index: 0, id: 'call-process', type: 'function', function: {
        name: 'process_start', arguments: JSON.stringify({ command: 'node server.cjs', waitForUrlMs: 5000 }),
      } }] } : { content: 'Server started' }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise<void>(resolve => llm.listen(0, '127.0.0.1', resolve))
  const address = llm.address()
  if (!address || typeof address === 'string') throw new Error('missing address')
  const configFile = join(workspace, 'config.json')
  await writeFile(configFile, JSON.stringify({ apiKey: 'test', protocol: 'openai', model: 'mock', baseUrl: `http://127.0.0.1:${address.port}/v1` }))
  await writeFile(join(workspace, 'server.cjs'), 'console.log("ready http://localhost:4321/"); setInterval(() => {}, 1000)')
  const server = await startWebServer({ port: 0, configFile, browser: false })
  const call = (path: string, method = 'GET', body?: unknown, scope = workspace) => fetch(`${server.url}${path}${path.includes('?') ? '&' : '?'}workspace=${encodeURIComponent(scope)}`, {
    method, headers: { 'x-tnega-client': '1', 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  try {
    const created: unknown = await (await call('/api/sessions', 'POST', { permission: 'bypass' })).json()
    if (!created || typeof created !== 'object') throw new Error('invalid response')
    const session: unknown = Reflect.get(created, 'session')
    if (!session || typeof session !== 'object') throw new Error('missing session')
    const id: unknown = Reflect.get(session, 'id')
    if (typeof id !== 'string') throw new Error('missing session ID')
    expect((await call(`/api/sessions/${id}`, 'PATCH', { permission: 'bypass' })).status).toBe(200)
    expect(await (await call(`/api/sessions/${id}/runs`, 'POST', { prompt: 'Start server' })).text()).toContain('Server started')
    expect(await (await call('/api/processes')).json()).toMatchObject({ processes: [{ id: 'p1', status: 'running', urls: ['http://localhost:4321/'] }] })
    if (process.platform === 'win32') {
      expect(await (await call('/api/processes', 'GET', undefined, workspace.toUpperCase())).json()).toMatchObject({ processes: [{ id: 'p1' }] })
    }
    expect(await (await call('/api/processes?process_id=p1')).json()).toMatchObject({ process: { status: 'running' }, output: expect.stringContaining('ready') })
    expect(await (await call('/api/processes', 'GET', undefined, join(workspace, 'other'))).json()).toEqual({ processes: [] })
    expect((await call('/api/processes', 'POST', { action: 'stop', process_id: 'p1' }, join(workspace, 'other'))).status).toBe(404)
    expect((await call('/api/processes', 'POST', { action: 'pause', process_id: 'p1' })).status).toBe(400)
    const stopped = await (await call('/api/processes', 'POST', { action: 'stop', process_id: 'p1' })).json()
    expect(stopped).toMatchObject({ process: { id: 'p1', status: 'killed' } })
    expect(await (await call('/api/processes?process_id=p1')).json()).toMatchObject({ output: expect.stringContaining('ready') })
  } finally {
    await server.close()
    await new Promise<void>(resolve => llm.close(() => resolve()))
    await rm(workspace, { recursive: true, force: true })
  }
}, 30_000)
