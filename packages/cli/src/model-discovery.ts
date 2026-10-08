import { networkFetch } from '@tnega/execution'
import { lookupModel } from '@tnega/llm'
import { CHATGPT_CODEX_BASE_URL, chatgptHeaders } from './chatgpt-auth.js'
import { modelConnection, modelSource, ModelRouteError, type SystemConfig } from './config.js'

export interface ModelDiscoveryInput {
  routeId?: string
  auth?: 'chatgpt'
  protocol?: 'openai' | 'anthropic'
  baseUrl?: string
  apiKey?: string
  apiKeyEnv?: string
}

export interface DiscoveredModel {
  id: string
  name: string
  contextWindow?: number
  vision?: boolean
}

export class ModelDiscoveryError extends Error {
  override name = 'ModelDiscoveryError'
  constructor(message: string, readonly status = 502) { super(message) }
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? Reflect.get(value, key) : undefined
}

export function parseModelDiscoveryInput(value: unknown): ModelDiscoveryInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ModelRouteError('model discovery must be an object')
  const input: ModelDiscoveryInput = {}
  for (const key of ['routeId', 'baseUrl', 'apiKey', 'apiKeyEnv'] as const) {
    const entry = field(value, key)
    if (entry === undefined) continue
    if (typeof entry !== 'string') throw new ModelRouteError(`${key} must be a string`)
    if (entry.trim()) input[key] = entry.trim()
  }
  const protocol = field(value, 'protocol')
  if (protocol !== undefined) {
    if (protocol !== 'openai' && protocol !== 'anthropic') throw new ModelRouteError('protocol must be openai or anthropic')
    input.protocol = protocol
  }
  const auth = field(value, 'auth')
  if (auth !== undefined) {
    if (auth !== 'chatgpt') throw new ModelRouteError('auth must be chatgpt')
    input.auth = auth
  }
  if (input.routeId && Object.keys(input).length > 1) throw new ModelRouteError('routeId must be used on its own to protect the saved credential')
  if (input.baseUrl) {
    let url: URL
    try { url = new URL(input.baseUrl) } catch { throw new ModelRouteError('baseUrl must be an http(s) URL') }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw new ModelRouteError('baseUrl must be an http(s) URL without credentials or a fragment')
  }
  if (input.auth && (input.baseUrl || input.apiKey || input.apiKeyEnv || input.protocol)) throw new ModelRouteError('ChatGPT discovery uses its own login and endpoint')
  return input
}

/** Read the authenticated live catalog; never substitute a static catalog on failure. */
export async function discoverModels(input: ModelDiscoveryInput, config: SystemConfig, options: {
  fetch?: typeof fetch
  env?: NodeJS.ProcessEnv
  authFile?: string
  timeoutMs?: number
} = {}): Promise<{ models: DiscoveredModel[]; source: 'provider' | 'third-party' }> {
  const env = options.env ?? process.env
  const saved = input.routeId ? modelConnection(config, input.routeId, env) : undefined
  if (input.routeId && !saved) throw new ModelRouteError('model route does not exist')
  const auth = saved?.auth ?? input.auth
  const protocol = saved?.protocol === 'anthropic' ? 'anthropic' : input.protocol ?? 'openai'
  const baseUrl = auth === 'chatgpt' ? CHATGPT_CODEX_BASE_URL
    : saved?.baseUrl ?? input.baseUrl ?? (protocol === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1')
  const key = saved ? (saved.apiKeyEnv ? env[saved.apiKeyEnv] : undefined) || saved.apiKey : input.apiKey || (input.apiKeyEnv ? env[input.apiKeyEnv] : undefined)
  if (!auth && !key) throw new ModelDiscoveryError('Add an API key or select a saved connection before fetching models.', 400)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('Model discovery timed out. Try again.')), options.timeoutMs ?? 15000)
  const request: typeof fetch = options.fetch ?? ((url, init) => networkFetch(new URL(String(url)), init ?? {}))
  const headers = new Headers({ accept: 'application/json' })
  const models = new Map<string, DiscoveredModel>()
  try {
    if (auth) {
      try { for (const [name, value] of Object.entries(await chatgptHeaders({ ...(options.authFile ? { file: options.authFile } : {}), fetch: request })(controller.signal))) headers.set(name, value) }
      catch { if (controller.signal.aborted) throw controller.signal.reason; throw new ModelDiscoveryError('ChatGPT login could not be refreshed. Sign in again from Settings → Models.', 401) }
    } else if (protocol === 'anthropic') {
      headers.set(saved?.apiKeyHeader ?? 'x-api-key', key ?? '')
      headers.set('anthropic-version', '2023-06-01')
    } else if (saved?.apiKeyHeader) headers.set(saved.apiKeyHeader, key ?? '')
    else headers.set('authorization', `Bearer ${key}`)
    const endpoint = new URL(baseUrl)
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}${protocol === 'anthropic' && !endpoint.pathname.replace(/\/$/, '').endsWith('/v1') ? '/v1' : ''}/models`
    // Pin the upstream catalog schema identity independently of Tnega's version.
    // Verified against @openai/codex 0.161.0 on the official npm registry.
    if (auth) endpoint.searchParams.set('client_version', '0.161.0')
    if (protocol === 'anthropic') endpoint.searchParams.set('limit', '1000')
    const cursors = new Set<string>()
    for (let page = 0; page < 50; page += 1) {
      const response = await request(endpoint, { method: 'GET', headers, redirect: 'error', signal: controller.signal })
      if (!response.ok) { await response.body?.cancel(); throw new ModelDiscoveryError(`Model discovery failed (HTTP ${response.status}). ${response.status === 401 || response.status === 403 ? 'Check this connection’s login or API key.' : 'Check the endpoint supports listing models.'}`, response.status === 401 || response.status === 403 ? response.status : 502) }
      const reader = response.body?.getReader()
      if (!reader) throw new ModelDiscoveryError('The endpoint returned an invalid model catalog.')
      const chunks: Uint8Array[] = []
      let bytes = 0
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          bytes += chunk.value.byteLength
          if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw new ModelDiscoveryError('The model catalog exceeds the 2 MB response limit.') }
          chunks.push(chunk.value)
        }
      } finally { reader.releaseLock() }
      let payload: unknown
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
      catch { throw new ModelDiscoveryError('The endpoint returned an invalid model catalog.') }
      const entries = field(payload, auth ? 'models' : 'data')
      if (!Array.isArray(entries)) throw new ModelDiscoveryError('The endpoint returned an invalid model catalog.')
      for (const entry of entries) {
        if (auth && field(entry, 'visibility') === 'hide') continue
        const id = field(entry, auth ? 'slug' : 'id')
        if (typeof id !== 'string' || !id.trim()) throw new ModelDiscoveryError('The endpoint returned an invalid model catalog.')
        const displayName = field(entry, 'display_name') ?? field(entry, 'name')
        const model: DiscoveredModel = { id, name: typeof displayName === 'string' && displayName.trim() ? displayName : id }
        const known = lookupModel(id)
        const context = field(entry, auth ? 'context_window' : 'max_input_tokens') ?? known?.contextWindow
        if (typeof context === 'number' && Number.isSafeInteger(context) && context > 0) model.contextWindow = context
        const modalities = field(entry, 'input_modalities')
        const image = field(field(field(entry, 'capabilities'), 'image_input'), 'supported')
        if (Array.isArray(modalities)) model.vision = modalities.includes('image')
        else if (typeof image === 'boolean') model.vision = image
        models.set(id, model)
      }
      if (protocol !== 'anthropic' || field(payload, 'has_more') !== true) return { models: [...models.values()], source: modelSource({ ...saved, ...(auth ? { auth } : {}), baseUrl }) }
      const cursor = field(payload, 'last_id')
      if (!entries.length || typeof cursor !== 'string' || !cursor || cursors.has(cursor)) throw new ModelDiscoveryError('The model catalog returned invalid pagination.')
      cursors.add(cursor)
      endpoint.searchParams.set('after_id', cursor)
    }
    throw new ModelDiscoveryError('The model catalog exceeded the pagination limit.')
  } catch (error) {
    if (controller.signal.aborted) throw new ModelDiscoveryError('Model discovery timed out. Try again.', 504)
    if (error instanceof ModelDiscoveryError) throw error
    throw new ModelDiscoveryError('Could not reach the model endpoint. Check its URL and Settings → Tools & shell → Network.')
  } finally { clearTimeout(timeout) }
}
