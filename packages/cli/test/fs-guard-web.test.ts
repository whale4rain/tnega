import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readSystemConfig } from '@tnega/config'
import { startWebServer } from '@tnega/host'

it('saves the file write guard and applies it to the next run', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'tnega-fs-guard-web-'))
  const results: string[] = []
  let writes = 0
  const llm = createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += String(chunk) })
    req.on('end', () => {
      const body = JSON.parse(raw) as { messages: Array<{ role: string; content: unknown }>; stream?: boolean }
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'Guard checks' }, finish_reason: 'stop' }] }))
        return
      }
      const last = body.messages.at(-1)
      let delta: Record<string, unknown>
      let finish = 'stop'
      if (last?.role === 'tool') {
        results.push(String(last.content))
        delta = { content: 'Done.' }
      } else {
        writes += 1
        delta = { tool_calls: [{ index: 0, id: `call-${writes}`, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'notes.txt', content: `run ${writes}\n` }) } }] }
        finish = 'tool_calls'
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise<void>(resolve => llm.listen(0, '127.0.0.1', resolve))
  const address = llm.address()
  if (!address || typeof address === 'string') throw new Error('missing address')
  const configFile = join(workspace, 'config.json')
  await writeFile(configFile, JSON.stringify({ apiKey: 'test', model: 'mock-model', protocol: 'openai', baseUrl: `http://127.0.0.1:${address.port}/v1` }))
  await writeFile(join(workspace, 'notes.txt'), 'written by a person\n')
  const server = await startWebServer({ port: 0, configFile, browser: false })
  const call = (path: string, method = 'GET', body?: unknown) => fetch(`${server.url}${path}?workspace=${encodeURIComponent(workspace)}`, {
    method, headers: { 'x-tnega-client': '1', 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  try {
    expect(await (await call('/api/config')).json()).toMatchObject({ config: { fsGuard: 'warn' } })
    expect((await call('/api/config', 'PUT', { fsGuard: 'strict' })).status).toBe(400)
    const saved = await call('/api/config', 'PUT', { fsGuard: 'enforce' })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ config: { fsGuard: 'enforce' } })
    expect((await readSystemConfig(configFile)).fsGuard).toBe('enforce')

    const created = await (await call('/api/sessions', 'POST', {})).json() as { session: { id: string } }
    // Writes inside the workspace then go through without an approval prompt.
    expect((await call(`/api/sessions/${created.session.id}`, 'PATCH', { permission: 'workspace-write' })).status).toBe(200)
    await (await call(`/api/sessions/${created.session.id}/runs`, 'POST', { prompt: 'Overwrite notes.txt' })).text()
    // Enforced: the file was never read in this session, so the write is refused.
    expect(results.at(-1)).toMatch(/has not been read/)
    expect(await readFile(join(workspace, 'notes.txt'), 'utf8')).toBe('written by a person\n')
  } finally {
    await server.close()
    await new Promise<void>((resolve, reject) => llm.close(error => error ? reject(error) : resolve()))
    // Windows can hold the Session files for a moment after the server closes.
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
