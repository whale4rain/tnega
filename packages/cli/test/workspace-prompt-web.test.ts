import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { startWebServer } from '../src/server.js'

it('injects saved instructions into real requests and removes them after clearing', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'tnega-prompt-web-'))
  const requests: string[] = []
  const llm = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += String(chunk) })
    req.on('end', () => {
      requests.push(body)
      if (!body.includes('"stream":true')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'Greeting session' }, finish_reason: 'stop' }] }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Finished.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise<void>(resolve => llm.listen(0, '127.0.0.1', resolve))
  const address = llm.address()
  if (!address || typeof address === 'string') throw new Error('missing address')
  const configFile = join(workspace, 'config.json')
  await writeFile(configFile, JSON.stringify({ apiKey: 'test', model: 'mock', baseUrl: `http://127.0.0.1:${address.port}/v1` }))
  const server = await startWebServer({ port: 0, configFile, browser: false })
  const call = (path: string, method = 'GET', body?: unknown) => fetch(`${server.url}${path}?workspace=${encodeURIComponent(workspace)}`, {
    method, headers: { 'x-tnega-client': '1', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  try {
    expect((await call('/api/workspace-prompt', 'PUT', { prompt: 1 })).status).toBe(400)
    expect((await call('/api/workspace-prompt', 'PUT', { prompt: 'Reply with a short poem.' })).status).toBe(200)
    expect(await (await call('/api/workspace-prompt')).json()).toEqual({ prompt: 'Reply with a short poem.' })
    const created = await (await call('/api/sessions', 'POST', { permission: 'bypass' })).json()
    if (!created || typeof created !== 'object' || !('session' in created)
      || !created.session || typeof created.session !== 'object' || !('id' in created.session)
      || typeof created.session.id !== 'string') throw new Error('missing session id')
    const path = `/api/sessions/${created.session.id}/runs`
    expect(await (await call(path, 'POST', { prompt: 'Hello' })).text()).toContain('Finished.')
    expect(requests[0]).toContain('Reply with a short poem.')
    expect(await (await call(`/api/sessions/${created.session.id}`)).json()).toMatchObject({ summary: { title: 'Greeting session' } })
    await call('/api/workspace-prompt', 'PUT', { prompt: '' })
    const before = requests.length
    await (await call(path, 'POST', { prompt: 'Again' })).text()
    expect(requests.slice(before).join('')).not.toContain('Reply with a short poem.')
  } finally {
    await server.close()
    await new Promise<void>(resolve => llm.close(() => resolve()))
    await rm(workspace, { recursive: true, force: true })
  }
}, 60000)
