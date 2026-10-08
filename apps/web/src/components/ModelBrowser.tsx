import { Plus, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { errorText } from '../lib/hooks'
import type { ConfigSnapshot, DiscoveredModel, ModelDiscovery, ModelDiscoveryInput, ModelRouteInput, ModelRouteSettings } from '../lib/types'
import { ChatGptSignIn } from './ChatGptSignIn'
import { RouteForm, newModelRouteId, providerBaseUrl } from './ModelRouteForm'

/** Discover with an existing login or connection; credentials stay on the server. */
export function ModelBrowser({ config, onSaved, onCancel, initialConnection, onPersisted }: {
  config: ConfigSnapshot
  onSaved: (config: ConfigSnapshot, id: string) => void
  onCancel: () => void
  initialConnection?: string | undefined
  onPersisted?: ((config: ConfigSnapshot) => void) | undefined
}) {
  const [current, setCurrent] = useState(config)
  useEffect(() => { setCurrent(config) }, [config])
  const registered = current.config.models ?? []
  const legacy = current.models.find(model => model.id === current.effective.modelId)
  const legacyProtocol = current.effective.protocol ?? legacy?.protocol
  const routes: ModelRouteSettings[] = registered.length ? registered : current.effective.modelId ? [{
    id: current.effective.modelId, model: current.effective.model, name: legacy?.name ?? current.effective.modelId,
    apiKeySet: current.apiKeySet, baseUrl: current.effective.baseUrl,
    ...(legacyProtocol ? { protocol: legacyProtocol } : {}),
    ...(legacy?.source ? { source: legacy.source } : {}),
  }] : []
  const defaultConnection = routes.find(route => route.apiKeySet || route.auth === 'chatgpt')
  const [connection, setConnection] = useState(initialConnection ?? (defaultConnection ? `route:${defaultConnection.id}` : 'chatgpt'))
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [catalog, setCatalog] = useState<ModelDiscovery>()
  const [search, setSearch] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [manual, setManual] = useState(false)
  const [addedHere, setAddedHere] = useState<string[]>([])
  const request = useRef<AbortController | undefined>(undefined)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false; request.current?.abort() } }, [])
  const routeId = connection.startsWith('route:') ? connection.slice(6) : undefined
  const sourceRoute = routes.find(route => route.id === routeId)
  const custom = connection === 'openai' || connection === 'anthropic'
  const customProtocol = connection === 'anthropic' ? 'anthropic' : 'openai'
  const input: ModelDiscoveryInput = routeId ? { routeId }
    : connection === 'chatgpt' ? { auth: 'chatgpt' }
      : { protocol: customProtocol, baseUrl: baseUrl.trim() || providerBaseUrl(customProtocol), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }
  const seed: ModelRouteInput = {
    model: '',
    ...(routeId ? { sourceRouteId: routeId, ...(sourceRoute?.auth ? { auth: sourceRoute.auth } : {}) } : { ...input }),
    ...(catalog ? { source: catalog.source } : {}),
  }
  const getModels = async () => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setError(undefined)
    setCatalog(undefined)
    try {
      const next = await api.discoverModels(input, controller.signal)
      if (alive.current && !controller.signal.aborted) setCatalog(next)
    } catch (reason) {
      if (alive.current && !controller.signal.aborted) setError(errorText(reason))
    } finally {
      if (alive.current && !controller.signal.aborted) setBusy(false)
    }
  }
  const added = (model: DiscoveredModel) => addedHere.includes(model.id) || routes.some(route =>
    (route.model ?? route.id) === model.id && (routeId ? route.id === routeId : connection === 'chatgpt' && route.auth === 'chatgpt'))
  const add = async (model: DiscoveredModel) => {
    if (!catalog || busy || added(model)) return
    setBusy(true)
    setError(undefined)
    const id = newModelRouteId(model.id, current.models.map(option => option.id))
    const payload: ModelRouteInput = {
      ...seed, model: model.id, name: model.name, source: catalog.source,
      ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      ...(model.vision !== undefined ? { vision: model.vision } : {}),
    }
    try {
      const next = await api.saveModelRoute(id, payload)
      onPersisted?.(next)
      if (alive.current) { setCurrent(next); setAddedHere(ids => [...ids, model.id]); onSaved(next, id) }
    } catch (reason) {
      if (alive.current) setError(errorText(reason))
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  if (manual) return <RouteForm existing={current.models.map(model => model.id)} initial={seed} onSaved={onSaved} onPersisted={next => { if (alive.current) setCurrent(next); onPersisted?.(next) }} onCancel={() => setManual(false)} />
  const filtered = catalog?.models.filter(model => `${model.name} ${model.id}`.toLowerCase().includes(search.toLowerCase())) ?? []
  return <div className="model-browser">
    <label className="field">
      <span className="field-label">Connection</span>
      <select value={connection} disabled={busy} onChange={event => { setConnection(event.target.value); setCatalog(undefined); setError(undefined); setSearch(''); setAddedHere([]) }}>
        <optgroup label="Model providers"><option value="chatgpt">ChatGPT sign-in</option></optgroup>
        {routes.length > 0 && <optgroup label="Saved connections">{routes.map(route => <option key={route.id} value={`route:${route.id}`}>{route.name ?? route.id}</option>)}</optgroup>}
        <optgroup label="API connections"><option value="openai">OpenAI compatible</option><option value="anthropic">Anthropic</option></optgroup>
      </select>
    </label>
    {connection === 'chatgpt' && <ChatGptSignIn onChanged={next => { setCurrent(next); setCatalog(undefined) }} />}
    {custom && <div className="form-grid">
      <label className="field"><span className="field-label">Base URL</span><input value={baseUrl} onChange={event => { setBaseUrl(event.target.value); setCatalog(undefined); setAddedHere([]) }} placeholder={connection === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'} disabled={busy} spellCheck={false} /></label>
      <label className="field"><span className="field-label">API key</span><input type="password" value={apiKey} onChange={event => { setApiKey(event.target.value); setCatalog(undefined); setAddedHere([]) }} placeholder="Use environment key or paste a key" autoComplete="off" disabled={busy} /></label>
    </div>}
    <div className="model-browser-actions"><button type="button" className="button secondary small" disabled={busy} onClick={() => void getModels()}><RefreshCw size={13} />{busy ? 'Loading…' : 'Get models'}</button><button type="button" className="button ghost small" disabled={busy} onClick={() => setManual(true)}>Enter model manually</button></div>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {catalog && <>
      <label className="field"><span className="field-label">Search models</span><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search by name or model id" /></label>
      <div className="menu-heading">{catalog.source === 'provider' ? 'Model providers' : 'Third-party'}</div>
      <div className="model-catalog" aria-label="Available models">
        {filtered.map(model => <div className="model-catalog-row" key={model.id}><span className="model-route-text"><span className="model-route-name">{model.name}</span><span className="model-route-meta">{model.id}{model.contextWindow ? ` · ${Math.round(model.contextWindow / 1000)}k` : ''}</span></span><button type="button" className="button ghost small" disabled={busy || added(model)} aria-label={added(model) ? 'Already added' : `Add ${model.name}`} onClick={() => void add(model)}>{added(model) ? 'Added' : <><Plus size={13} /> Add</>}</button></div>)}
        {filtered.length === 0 && <p className="muted small" role="status">{catalog.models.length ? 'No matching models.' : 'This connection returned no models. You can enter a model id manually.'}</p>}
      </div>
    </>}
    <div className="model-route-form-actions"><button type="button" className="button ghost small" onClick={onCancel}>Cancel</button></div>
  </div>
}
