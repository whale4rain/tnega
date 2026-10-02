import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { startWebServer } from '../src/server.js'

it('lists background work while the session is idle and stops it without leaking across sessions', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'tnega-jobs-web-'))
  let parentRequests = 0
  let markChildStarted = () => {}
  const childStarted = new Promise<void>(resolve => { markChildStarted = resolve })
  const llm = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += String(chunk) })
    req.on('end', () => {
      if (body.includes('background-child-marker')) {
        // The parent also includes the task in its tool result history.
        const parsed: { messages: Array<{ role: string; content?: string }> } = JSON.parse(body)
        if (parsed.messages.some(message => message.role === 'user' && message.content?.endsWith('Task: background-child-marker'))) {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.flushHeaders()
          markChildStarted()
          return
        }
      }
      parentRequests++
      const delta = parentRequests === 1 ? { tool_calls: [{ index: 0, id: 'call-job', type: 'function', function: {
        name: 'job_start', arguments: JSON.stringify({ kind: 'subagent', task: 'background-child-marker', label: 'Long task' }),
      } }] } : { content: 'Background task started' }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: parentRequests === 1 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise<void>(resolve => llm.listen(0, '127.0.0.1', resolve))
  const address = llm.address()
  if (!address || typeof address === 'string') throw new Error('mock address unavailable')
  const configFile = join(workspace, 'config.json')
  await writeFile(configFile, JSON.stringify({ apiKey: 'test', model: 'mock-model', protocol: 'openai', baseUrl: `http://127.0.0.1:${address.port}/v1` }))
  const server = await startWebServer({ port: 0, configFile })
  async function call(path: string, method = 'GET', body?: unknown) {
    return fetch(`${server.url}${path}${path.includes('?') ? '&' : '?'}workspace=${encodeURIComponent(workspace)}`, {
      method, headers: { 'x-tnega-client': '1', 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  }
  async function createSession(): Promise<string> {
    const result: unknown = await (await call('/api/sessions', 'POST', { permission: 'bypass' })).json()
    if (!result || typeof result !== 'object' || !('session' in result) || !result.session
      || typeof result.session !== 'object' || !('id' in result.session) || typeof result.session.id !== 'string') {
      throw new Error('Invalid session response')
    }
    return result.session.id
  }
  try {
    const id = await createSession()
    const otherId = await createSession()
    expect((await call(`/api/sessions/${id}`, 'PATCH', { permission: 'bypass' })).status).toBe(200)
    expect(await (await call(`/api/sessions/${id}/jobs`)).json()).toEqual({ jobs: [] })
    const run = await call(`/api/sessions/${id}/runs`, 'POST', { prompt: 'Delegate long task' })
    const runEvents = await run.text()
    expect(runEvents).toContain('Background task started')
    expect(await (await call(`/api/sessions/${id}/jobs`)).json()).toMatchObject({ jobs: [{ status: 'running' }] })
    await childStarted
    const listed: unknown = await (await call(`/api/sessions/${id}/jobs`)).json()
    if (!listed || typeof listed !== 'object' || !('jobs' in listed) || !Array.isArray(listed.jobs)) throw new Error('Invalid jobs response')
    expect(listed.jobs).toHaveLength(1)
    expect(listed.jobs[0]).toMatchObject({ status: 'running', label: 'Long task' })
    const firstJob: unknown = listed.jobs[0]
    if (!firstJob || typeof firstJob !== 'object' || !('id' in firstJob) || typeof firstJob.id !== 'string') throw new Error('Invalid job')
    const jobId = firstJob.id
    expect(await (await call(`/api/sessions/${otherId}/jobs`)).json()).toEqual({ jobs: [] })
    expect((await call(`/api/sessions/${otherId}/jobs?job_id=${jobId}`)).status).toBe(404)
    expect((await call(`/api/sessions/${otherId}/jobs`, 'POST', { action: 'stop', job_id: jobId })).status).toBe(404)
    expect((await call(`/api/sessions/${id}/jobs`, 'POST', { action: 'pause', job_id: jobId })).status).toBe(400)
    const stopped = await call(`/api/sessions/${id}/jobs`, 'POST', { action: 'stop', job_id: jobId })
    expect(stopped.status).toBe(200)
    expect(await stopped.json()).toMatchObject({ job: { id: jobId, status: 'stopping' } })
    await expect.poll(async () => {
      const response: unknown = await (await call(`/api/sessions/${id}/jobs?job_id=${jobId}`)).json()
      if (!response || typeof response !== 'object' || !('job' in response) || !response.job
        || typeof response.job !== 'object' || !('status' in response.job)) throw new Error('Invalid job response')
      return response.job.status
    }, { timeout: 10_000 }).toBe('killed')
    expect((await call('/api/sessions/00000000-0000-4000-8000-000000000000/jobs')).status).toBe(404)
  } finally {
    await server.close()
    llm.closeAllConnections()
    await new Promise<void>((resolve, reject) => llm.close(error => error ? reject(error) : resolve()))
    await rm(workspace, { recursive: true, force: true })
  }
}, 20_000)
