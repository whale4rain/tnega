import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { startWebServer } from '../src/server.js'

it('compacts a long web session by itself once it passes 75% of the window', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'tnega-autocompact-'))
  const seen: Array<{ kind: 'run' | 'summary' | 'judge'; text: string }> = []
  let reads = 0
  const llm = createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += String(chunk) })
    req.on('end', () => {
      const body = JSON.parse(raw) as { messages: Array<{ role: string; content: unknown }>; stream?: boolean }
      const text = JSON.stringify(body.messages)
      const system = String(body.messages[0]?.content ?? '')
      const kind = system.startsWith('You are a context summarization assistant') ? 'summary'
        : system.startsWith('You check on an AI coding agent') ? 'judge' : 'run'
      seen.push({ kind, text })
      let delta: Record<string, unknown>
      let finish = 'stop'
      if (kind === 'summary') delta = { content: '## Goal\nRead the big file three times.' }
      else if (kind === 'judge') delta = { content: 'NO' }
      else if (reads < 3) {
        reads += 1
        delta = { tool_calls: [{ index: 0, id: `call-${reads}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'big.txt' }) } }] }
        finish = 'tool_calls'
      } else delta = { content: 'Read it three times.' }
      if (!body.stream) {
        // Summaries and the near-end check are plain completions.
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', ...delta }, finish_reason: finish }] }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise<void>(resolve => llm.listen(0, '127.0.0.1', resolve))
  const address = llm.address()
  if (!address || typeof address === 'string') throw new Error('missing address')
  const configFile = join(workspace, 'config.json')
  await writeFile(configFile, JSON.stringify({
    model: 'small',
    models: [{ id: 'small', model: 'mock', apiKey: 'test', protocol: 'openai', baseUrl: `http://127.0.0.1:${address.port}/v1`, contextWindow: 16_000 }],
  }))
  await writeFile(join(workspace, 'big.txt'), 'lorem ipsum '.repeat(1400))
  const server = await startWebServer({ port: 0, configFile, browser: false })
  const call = (path: string, method = 'GET', body?: unknown) => fetch(`${server.url}${path}${path.includes('?') ? '&' : '?'}workspace=${encodeURIComponent(workspace)}`, {
    method, headers: { 'x-tnega-client': '1', 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  try {
    const created = await (await call('/api/sessions', 'POST', { permission: 'bypass' })).json() as { session: { id: string } }
    const id = created.session.id
    expect(await (await call(`/api/sessions/${id}/runs`, 'POST', { prompt: 'Read big.txt three times' })).text()).toContain('Read it three times.')
    // Past 75% mid-run, the model is asked whether it is nearly done, says no, and the session compacts.
    const kinds = seen.map(entry => entry.kind)
    expect(kinds).toContain('judge')
    expect(kinds).toContain('summary')
    const afterSummary = seen.slice(kinds.indexOf('summary') + 1).find(entry => entry.kind === 'run')
    expect(afterSummary?.text).toContain('[compressed conversation]')
    expect(afterSummary?.text).toContain('Read the big file three times.')
    const detail = await (await call(`/api/sessions/${id}`)).json() as { events: Array<{ type: string }> }
    expect(detail.events.some(event => event.type === 'checkpoint')).toBe(true)
  } finally {
    await server.close()
    await new Promise<void>(resolve => llm.close(() => resolve()))
    await rm(workspace, { recursive: true, force: true })
  }
}, 60_000)
