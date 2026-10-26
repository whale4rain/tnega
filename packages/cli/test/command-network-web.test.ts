import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readSystemConfig } from '@tnega/config'
import { startWebServer } from '@tnega/host'

it('saves command network rules, names a bad rule, and clears them again', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'tnega-command-network-'))
  const configFile = join(workspace, 'config.json')
  await writeFile(configFile, JSON.stringify({ apiKey: 'test', model: 'mock-model' }))
  const server = await startWebServer({ port: 0, configFile, browser: false })
  const call = (path: string, method = 'GET', body?: unknown) => fetch(`${server.url}${path}`, {
    method, headers: { 'x-tnega-client': '1', 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  try {
    expect(await (await call('/api/config')).json()).toMatchObject({ sandbox: { network: { mode: 'open', allowedDomains: [], deniedDomains: [] } } })

    const bad = await call('/api/config', 'PUT', { sandbox: { network: { mode: 'allowlist', allowedDomains: ['github.com', 'https://x.dev/'] } } })
    expect(bad.status).toBe(400)
    expect((await bad.json() as { error: string }).error).toContain('allowedDomains has entries that are not domains: "https://x.dev/"')
    expect((await call('/api/config', 'PUT', { sandbox: { network: { mode: 'wide' } } })).status).toBe(400)

    const saved = await call('/api/config', 'PUT', { sandbox: { network: { mode: 'allowlist', allowedDomains: ['GitHub.com', '*.github.com'], deniedDomains: ['gist.github.com'] } } })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ sandbox: { network: { mode: 'allowlist', allowedDomains: ['github.com', '*.github.com'], deniedDomains: ['gist.github.com'] } } })
    expect((await readSystemConfig(configFile)).sandbox?.network?.mode).toBe('allowlist')

    // Open with no rules is the default, so the section disappears from the file.
    expect((await call('/api/config', 'PUT', { sandbox: { network: { mode: 'open', allowedDomains: [], deniedDomains: [] } } })).status).toBe(200)
    expect((await readSystemConfig(configFile)).sandbox).toBeUndefined()

    const support = await (await call('/api/sandbox/network')).json() as { filtering: unknown }
    expect(typeof support.filtering).toBe('boolean')
  } finally {
    await server.close()
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}, 30_000)

/** One turn where the model asks for network access; `allow` answers the approval card. */
async function askForAccess(allow: boolean): Promise<{ approvals: string[]; output: unknown; saved: string[] | undefined; tools: string[] }> {
  const workspace = await mkdtemp(join(tmpdir(), 'tnega-network-ask-'))
  let requests = 0
  let tools: string[] = []
  const llm = createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += String(chunk) })
    req.on('end', () => {
      const body = JSON.parse(raw) as { stream?: boolean; tools?: Array<{ function: { name: string } }> }
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'Network' }, finish_reason: 'stop' }] }))
        return
      }
      const first = ++requests === 1
      if (first) tools = (body.tools ?? []).map(tool => tool.function.name)
      const args = { domains: ['pypi.org'], reason: 'pip install requests', remember: true }
      const delta = first
        ? { tool_calls: [{ index: 0, id: 'call-net', type: 'function', function: { name: 'request_network_access', arguments: JSON.stringify(args) } }] }
        : { content: 'Done.' }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise<void>(resolve => llm.listen(0, '127.0.0.1', resolve))
  const address = llm.address()
  if (!address || typeof address === 'string') throw new Error('missing address')
  const configFile = join(workspace, 'config.json')
  await writeFile(configFile, JSON.stringify({
    apiKey: 'test', protocol: 'openai', model: 'mock', baseUrl: `http://127.0.0.1:${address.port}/v1`,
    sandbox: { network: { mode: 'allowlist', allowedDomains: ['github.com'] } },
  }))
  const server = await startWebServer({ port: 0, configFile, browser: false })
  const url = (path: string) => `${server.url}${path}?workspace=${encodeURIComponent(workspace)}`
  const headers = { 'x-tnega-client': '1', 'content-type': 'application/json' }
  try {
    const created = await (await fetch(url('/api/sessions'), { method: 'POST', headers, body: JSON.stringify({}) })).json() as { session: { id: string } }
    const id = created.session.id
    expect((await fetch(url(`/api/sessions/${id}`), { method: 'PATCH', headers, body: JSON.stringify({ permission: 'workspace-write' }) })).status).toBe(200)
    const response = await fetch(url(`/api/sessions/${id}/runs`), { method: 'POST', headers, body: JSON.stringify({ prompt: 'Install requests' }) })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const approvals: string[] = []
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let end: number
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const data = buffer.slice(0, end).split('\n').find(line => line.startsWith('data: '))?.slice(6)
        buffer = buffer.slice(end + 2)
        if (!data) continue
        const event = JSON.parse(data) as { type: string; id?: string; tool?: string }
        if (event.type !== 'approval/request') continue
        approvals.push(event.tool ?? '')
        await fetch(url(`/api/sessions/${id}/approvals/${event.id}`), { method: 'POST', headers, body: JSON.stringify({ allow }) })
      }
    }
    const detail = await (await fetch(url(`/api/sessions/${id}`), { headers })).json() as { events: Array<{ type: string; payload: Record<string, unknown> }> }
    const result = detail.events.find(event => event.type === 'tool/result' && event.payload.name === 'request_network_access')
    return {
      approvals, tools,
      output: result?.payload.output ?? result?.payload.error,
      saved: (await readSystemConfig(configFile)).sandbox?.network?.allowedDomains,
    }
  } finally {
    await server.close()
    await new Promise<void>(resolve => llm.close(() => resolve()))
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}

it('lets a person approve a domain the agent asks for, and saves it when asked to remember', async () => {
  const approved = await askForAccess(true)
  expect(approved.tools).toContain('request_network_access')
  expect(approved.approvals).toEqual(['request_network_access'])
  expect(approved.output).toMatchObject({ granted: ['pypi.org'], remembered: true })
  expect(approved.saved).toEqual(['github.com', 'pypi.org'])
}, 60_000)

it('changes nothing when the person denies the request', async () => {
  const denied = await askForAccess(false)
  expect(denied.approvals).toEqual(['request_network_access'])
  expect(denied.saved).toEqual(['github.com'])
}, 60_000)
