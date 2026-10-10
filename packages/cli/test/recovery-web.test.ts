import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { SessionLog } from '@tnega/session'
import { startWebServer } from '../src/server.js'
import { sessionFile } from '../src/store.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

it('reports a crash-cut turn and continues it through a resumed run', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'tnega-recovery-web-'))
  cleanup.push(() => rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  const requests: Array<{ messages: Array<{ role: string; content?: string }> }> = []
  const llm = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += String(chunk) })
    req.on('end', () => {
      requests.push(JSON.parse(body))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'picked up' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise<void>(resolve => llm.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve, reject) => llm.close(error => error ? reject(error) : resolve())))
  const address = llm.address()
  if (!address || typeof address === 'string') throw new Error('mock address unavailable')
  const configFile = join(workspace, 'config.json')
  await writeFile(configFile, JSON.stringify({ apiKey: 'test', model: 'mock-model', protocol: 'openai', baseUrl: `http://127.0.0.1:${address.port}/v1` }))
  const server = await startWebServer({ port: 0, configFile })
  cleanup.push(server.close)
  const call = (path: string, body?: unknown) => fetch(`${server.url}${path}?workspace=${encodeURIComponent(workspace)}`, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: { 'x-tnega-client': '1', 'content-type': 'application/json' },
  })
  const { session } = await (await call('/api/sessions', {})).json() as { session: { id: string } }

  // A previous process died while read_file was running.
  const log = new SessionLog(sessionFile(workspace, session.id))
  await log.init()
  await log.append('meta', { kind: 'agent', agentId: session.id, mode: 'auto', createdAt: 1 })
  await log.append('turn/start', { turn: 1, input: 'look', reason: 'user' })
  await log.append('step/start', { turn: 1, step: 0 })
  await log.append('user/message', { content: 'look at the readme' })
  await log.append('assistant/message', { content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'README.md' } }] })
  await log.append('tool/call', { id: 'c1', name: 'read_file', arguments: { path: 'README.md' }, interruption: 'retry' })
  await log.close()

  const detail = await (await call(`/api/sessions/${session.id}`)).json() as { recovery?: { safe: boolean } }
  expect(detail.recovery).toEqual({ safe: true, uncertainCalls: [] })

  const recovered = await call(`/api/sessions/${session.id}/recover`, {})
  expect(await recovered.json()).toEqual({ resumeQueued: true })
  expect(await (await call(`/api/sessions/${session.id}/runs`, { resumeQueued: true })).text()).toContain('picked up')
  const last = requests.at(-1)?.messages
  expect(last?.at(-1)?.content).toContain('The previous run was interrupted')
  expect(last?.some(message => message.role === 'tool' && message.content?.includes('TOOL_OUTCOME_UNKNOWN'))).toBe(true)

  const after = await (await call(`/api/sessions/${session.id}`)).json() as { recovery?: unknown }
  expect(after.recovery).toBeUndefined()
  expect(await (await call(`/api/sessions/${session.id}/recover`, {})).json()).toEqual({ resumeQueued: false })
})
