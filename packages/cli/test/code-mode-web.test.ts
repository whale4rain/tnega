import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readSystemConfig } from '../src/config.js'
import { startWebServer } from '../src/server.js'

it.each([true, false])('switches the complete model tool surface across runs (resident=%s)', async resident => {
  const workspace = await mkdtemp(join(tmpdir(), 'tnega-code-mode-web-'))
  const requests: Array<{ tools: Array<{ function: { name: string } }> }> = []
  const llm = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += String(chunk) })
    req.on('end', () => {
      if (body.includes('Name this Session from the first user intent.')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Tool checks' }, finish_reason: 'stop' }] }))
        return
      }
      requests.push(JSON.parse(body))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Done' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise<void>(resolve => llm.listen(0, '127.0.0.1', resolve))
  const address = llm.address()
  if (!address || typeof address === 'string') throw new Error('mock address unavailable')
  const configFile = join(workspace, 'config.json')
  await writeFile(configFile, JSON.stringify({ apiKey: 'test', model: 'mock-model', protocol: 'openai', baseUrl: `http://127.0.0.1:${address.port}/v1` }))
  const server = await startWebServer({ port: 0, configFile, resident })
  const headers = { 'x-tnega-client': '1', 'content-type': 'application/json' }
  async function call(path: string, method = 'GET', body?: unknown) {
    return fetch(`${server.url}${path}?workspace=${encodeURIComponent(workspace)}`, {
      method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  }
  try {
    const snapshot = await (await call('/api/config')).json()
    expect(snapshot).toMatchObject({ config: { codeMode: false } })
    const created = await (await call('/api/sessions', 'POST', {})).json()
    if (!created || typeof created !== 'object' || !('session' in created) || !created.session
      || typeof created.session !== 'object' || !('id' in created.session) || typeof created.session.id !== 'string') {
      throw new Error('Session creation response is invalid')
    }
    const id = created.session.id
    await (await call(`/api/sessions/${id}/runs`, 'POST', { prompt: 'Check native tools' })).text()
    expect(requests.at(-1)?.tools.map(tool => tool.function.name)).toContain('ask_user_question')
    expect(requests.at(-1)?.tools.map(tool => tool.function.name)).toEqual(expect.arrayContaining(['job_start', 'job_list', 'job_output', 'job_kill']))
    expect(requests.at(-1)?.tools.map(tool => tool.function.name)).not.toContain('run_code')
    expect((await call('/api/config', 'PUT', { codeMode: true })).status).toBe(200)
    expect((await readSystemConfig(configFile)).codeMode).toBe(true)
    await (await call(`/api/sessions/${id}/runs`, 'POST', { prompt: 'Check CodeMode tools' })).text()
    expect(requests.at(-1)?.tools.map(tool => tool.function.name)).toEqual(['run_code'])
    expect((await call('/api/config', 'PUT', { codeMode: false })).status).toBe(200)
    expect((await readSystemConfig(configFile)).codeMode).toBe(false)
    await (await call(`/api/sessions/${id}/runs`, 'POST', { prompt: 'Back to native tools' })).text()
    expect(requests.at(-1)?.tools.map(tool => tool.function.name)).toContain('ask_user_question')
    expect(requests.at(-1)?.tools.map(tool => tool.function.name)).not.toContain('run_code')
    expect((await call('/api/config', 'PUT', { codeMode: 'both' })).status).toBe(400)
    expect((await readSystemConfig(configFile)).codeMode).toBe(false)
  } finally {
    await server.close()
    await new Promise<void>((resolve, reject) => llm.close(error => error ? reject(error) : resolve()))
    await rm(workspace, { recursive: true, force: true })
  }
})
