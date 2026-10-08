import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createLlmAdapter } from '@tnega/llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { discoverModels, parseModelDiscoveryInput } from '../src/model-discovery.js'
import { availableModels, effectiveLlmConfig, parseModelRouteInput, readSystemConfig, upsertModelRoute, type SystemConfig } from '../src/config.js'
import { startWebServer, type WebServer } from '../src/server.js'

const dirs: string[] = []
const servers: WebServer[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(servers.splice(0).map(server => server.close()))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('model discovery', () => {
  it('uses the saved endpoint and credential without returning secrets, deduplicating ids', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: 'one' }, { id: 'one' }, { id: 'two', name: 'Two' }] }))
    const result = await discoverModels({ routeId: 'custom' }, { models: [{ id: 'custom', model: 'old', baseUrl: 'https://gateway.example/v1', apiKey: 'private-key', protocol: 'openai' }] }, { fetch: request })
    expect(result).toEqual({ source: 'third-party', models: [{ id: 'one', name: 'one' }, { id: 'two', name: 'Two' }] })
    expect(String(request.mock.calls[0]?.[0])).toBe('https://gateway.example/v1/models')
    expect(new Headers(request.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer private-key')
    expect(JSON.stringify(result)).not.toContain('private-key')
  })

  it('reads the environment credential and paginates Anthropic using last_id', async () => {
    let calls = 0
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      expect(new Headers(init?.headers).get('x-api-key')).toBe('ant-secret')
      expect(new Headers(init?.headers).get('anthropic-version')).toBe('2023-06-01')
      return Response.json(++calls === 1
        ? { data: [{ id: 'claude-one', display_name: 'Claude One', max_input_tokens: 200000, capabilities: { image_input: { supported: true } } }], has_more: true, last_id: 'claude-one' }
        : { data: [{ id: 'claude-two' }], has_more: false })
    })
    const result = await discoverModels({ protocol: 'anthropic', apiKeyEnv: 'MY_ANT_KEY' }, {}, { fetch: request, env: { MY_ANT_KEY: 'ant-secret' } })
    expect(result.source).toBe('provider')
    expect(result.models).toEqual([{ id: 'claude-one', name: 'Claude One', contextWindow: 200000, vision: true }, { id: 'claude-two', name: 'claude-two' }])
    expect(String(request.mock.calls[1]?.[0])).toContain('after_id=claude-one')
  })

  it('uses the same custom Anthropic authentication header as actual runtime requests', async () => {
    const paths: string[] = []
    const gateway = createServer((req, res) => {
      req.resume()
      paths.push(req.url ?? '')
      res.setHeader('content-type', 'application/json')
      if (req.headers['api-key'] !== 'gateway-key' || req.headers['x-api-key'] !== undefined || req.headers['anthropic-version'] !== '2023-06-01') {
        res.writeHead(401)
        res.end(JSON.stringify({ error: 'wrong authentication header' }))
        return
      }
      res.end(JSON.stringify(req.url?.startsWith('/v1/models')
        ? { data: [{ id: 'claude-gateway' }], has_more: false }
        : { id: 'msg-one', model: 'claude-gateway', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }))
    })
    await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve))
    try {
      const address = gateway.address()
      if (!address || typeof address === 'string') throw new Error('Missing fixture address')
      const config: SystemConfig = { models: [{ id: 'gateway', model: 'claude-gateway', protocol: 'anthropic', apiKeyHeader: 'api-key', apiKey: 'gateway-key', baseUrl: `http://127.0.0.1:${address.port}/v1` }] }
      const adapter = createLlmAdapter({ ...effectiveLlmConfig(config, {}, 'gateway'), apiKey: 'gateway-key', maxRetries: 0 })
      await adapter.complete([{ role: 'user', content: 'hello' }], [], {})
      expect(await discoverModels({ routeId: 'gateway' }, config, { fetch, env: {} })).toEqual({ source: 'third-party', models: [{ id: 'claude-gateway', name: 'claude-gateway' }] })
      expect(paths).toEqual(['/v1/messages', '/v1/models?limit=1000'])
    } finally { await new Promise<void>((resolve, reject) => gateway.close(error => error ? reject(error) : resolve())) }
  })

  it('never sends a global key to a saved connection and preserves its inherited runtime endpoint', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ data: [] }))
    await expect(discoverModels({ routeId: 'missing-key' }, { apiKey: 'unrelated', models: [{ id: 'missing-key', baseUrl: 'https://gateway.example/v1' }] }, { fetch: request, env: { OPENAI_API_KEY: 'unrelated-env' } })).rejects.toThrow(/API key/)
    expect(request).not.toHaveBeenCalled()
    await discoverModels({ routeId: 'anthropic' }, { baseUrl: 'https://gateway.example/v1', models: [{ id: 'anthropic', protocol: 'anthropic', apiKey: 'correct' }] }, { fetch: request, env: {} })
    expect(String(request.mock.calls[0]?.[0])).toBe('https://gateway.example/v1/models?limit=1000')
    await discoverModels({ routeId: 'openai' }, { baseUrl: 'https://wrong.example/v1', apiKeyHeader: 'api-key', models: [{ id: 'openai', protocol: 'openai', apiKey: 'own-key' }] }, { fetch: request, env: { OPENCODE_GO_BASE_URL: 'https://env-gateway.example/v1' } })
    expect(String(request.mock.calls[1]?.[0])).toBe('https://env-gateway.example/v1/models')
    expect(new Headers(request.mock.calls[1]?.[1]?.headers).get('api-key')).toBe('own-key')
  })

  it('pins the effective inherited endpoint when cloning a saved connection', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tnega-discovery-inherited-')); dirs.push(dir)
    const file = join(dir, 'config.json')
    await writeFile(file, JSON.stringify({ baseUrl: 'https://global.example/v1', models: [{ id: 'source', model: 'old', apiKey: 'own-key', protocol: 'openai' }] }))
    vi.stubEnv('OPENCODE_GO_BASE_URL', 'https://env-gateway.example/v1')
    const next = await upsertModelRoute('copy', parseModelRouteInput({ model: 'new', sourceRouteId: 'source' }), file)
    expect(next.models?.find(model => model.id === 'copy')).toMatchObject({ baseUrl: 'https://env-gateway.example/v1', apiKey: 'own-key', source: 'third-party' })
  })

  it('uses refreshed ChatGPT account headers and filters hidden catalog models', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tnega-discovery-auth-')); dirs.push(dir)
    const authFile = join(dir, 'chatgpt.json')
    await writeFile(authFile, JSON.stringify({ accessToken: 'old', refreshToken: 'refresh', expiresAt: 1, accountId: 'account' }))
    const request = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith('/oauth/token')) return Response.json({ access_token: 'fresh', expires_in: 3600 })
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fresh')
      expect(new Headers(init?.headers).get('chatgpt-account-id')).toBe('account')
      expect(String(url)).toMatch(/codex\/models\?client_version=/)
      return Response.json({ models: [{ slug: 'gpt-one', display_name: 'GPT One', visibility: 'list', context_window: 123000, input_modalities: ['text', 'image'] }, { slug: 'internal', visibility: 'hide' }] })
    })
    expect(await discoverModels({ auth: 'chatgpt' }, {}, { fetch: request, authFile })).toEqual({ source: 'provider', models: [{ id: 'gpt-one', name: 'GPT One', contextWindow: 123000, vision: true }] })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('rejects unsafe input, missing routes, bad catalogs and provider errors without echoing response secrets', async () => {
    expect(() => parseModelDiscoveryInput({ protocol: 'other' })).toThrow(/protocol/)
    expect(() => parseModelDiscoveryInput({ baseUrl: 'file:///secret' })).toThrow(/http/)
    expect(() => parseModelDiscoveryInput({ routeId: 'one', baseUrl: 'https://evil.example' })).toThrow(/routeId/)
    await expect(discoverModels({ routeId: 'missing' }, {})).rejects.toThrow(/route/)
    await expect(discoverModels({ protocol: 'openai', apiKey: 'secret' }, {}, { fetch: async () => new Response('secret', { status: 401 }) })).rejects.toThrow(/401/)
    await expect(discoverModels({ protocol: 'openai', apiKey: 'secret' }, {}, { fetch: async () => Response.json({ wrong: [] }) })).rejects.toThrow(/catalog/)
    await expect(discoverModels({ protocol: 'anthropic', apiKey: 'secret' }, {}, { fetch: async () => Response.json({ data: [], has_more: true, last_id: 'loop' }) })).rejects.toThrow(/pagination/)
  })

  it('times out the entire fetch and cancels its signal', async () => {
    const request: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }))
    await expect(discoverModels({ protocol: 'openai', apiKey: 'secret' }, {}, { fetch: request, timeoutMs: 10 })).rejects.toThrow(/timed out/)
  })

  it('copies only source connection settings when adding a model, preserving source and credentials', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tnega-discovery-copy-')); dirs.push(dir)
    const file = join(dir, 'config.json')
    await writeFile(file, JSON.stringify({ models: [{ id: 'gateway', model: 'old', baseUrl: 'https://gateway.example/v1', protocol: 'openai', apiKey: 'saved', source: 'third-party', vision: false, contextWindow: 1000, pricing: { input: 1, output: 1 } }] }))
    await upsertModelRoute('new', parseModelRouteInput({ model: 'discovered', sourceRouteId: 'gateway' }), file)
    const config = await readSystemConfig(file)
    expect(config.models?.[1]).toEqual({ id: 'new', model: 'discovered', baseUrl: 'https://gateway.example/v1', protocol: 'openai', apiKey: 'saved', source: 'third-party' })
    expect(availableModels(config, {}).find(model => model.id === 'new')?.source).toBe('third-party')
    await expect(upsertModelRoute('bad', parseModelRouteInput({ model: 'x', sourceRouteId: 'absent' }), file)).rejects.toThrow(/source/)
    await expect(upsertModelRoute('leak', parseModelRouteInput({ model: 'x', sourceRouteId: 'gateway', baseUrl: 'https://different.example/v1' }), file)).rejects.toThrow(/own API key/)
  })

  it('discovers and copies the legacy default using the same endpoint and environment credential', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: 'new' }] }))
    const config = { model: 'legacy', baseUrl: 'https://legacy.example/v1', protocol: 'openai' as const }
    await discoverModels({ routeId: 'legacy' }, config, { fetch: request, env: { OPENAI_API_KEY: 'legacy-key' } })
    expect(String(request.mock.calls[0]?.[0])).toBe('https://legacy.example/v1/models')
    expect(new Headers(request.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer legacy-key')
    const dir = await mkdtemp(join(tmpdir(), 'tnega-discovery-legacy-')); dirs.push(dir)
    const file = join(dir, 'config.json')
    await writeFile(file, JSON.stringify(config))
    vi.stubEnv('TNEGA_API_KEY', 'legacy-key')
    const next = await upsertModelRoute('new', parseModelRouteInput({ model: 'new', sourceRouteId: 'legacy' }), file)
    expect(next.models?.find(model => model.id === 'new')).toMatchObject({ baseUrl: config.baseUrl, apiKeyEnv: 'TNEGA_API_KEY', protocol: 'openai' })
  })

  it('bounds streamed model catalogs and rejects redirects without forwarding credentials', async () => {
    const oversized: typeof fetch = async () => new Response(' '.repeat(2 * 1024 * 1024 + 1))
    await expect(discoverModels({ apiKey: 'secret' }, {}, { fetch: oversized })).rejects.toThrow(/2 MB/)
    const request: typeof fetch = async (_url, init) => {
      expect(init?.redirect).toBe('error')
      return new Response(null, { status: 302, headers: { location: 'https://other.example' } })
    }
    await expect(discoverModels({ apiKey: 'secret' }, {}, { fetch: request })).rejects.toThrow(/302/)
  })

  it('exposes discovery over the guarded config API and never leaks the saved key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tnega-discovery-web-')); dirs.push(dir)
    const file = join(dir, 'config.json')
    await writeFile(file, JSON.stringify({ models: [{ id: 'saved', model: 'old', protocol: 'openai', baseUrl: 'https://example.com/v1', apiKey: 'hidden' }] }))
    const server = await startWebServer({ port: 0, host: '127.0.0.1', configFile: file, fetch: async () => Response.json({ data: [{ id: 'new' }] }) }); servers.push(server)
    const response = await fetch(`${server.url}/api/config/models/discover`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tnega-client': '1' }, body: JSON.stringify({ routeId: 'saved' }) })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ source: 'third-party', models: [{ id: 'new', name: 'new' }] })
    const invalid = await fetch(`${server.url}/api/config/models/discover`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tnega-client': '1' }, body: JSON.stringify({ routeId: 'unknown' }) })
    expect(invalid.status).toBe(400)
  })
})
