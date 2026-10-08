import { Eye, EyeOff, KeyRound } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { errorText } from '../lib/hooks'
import type { ConfigSnapshot, ModelRouteInput, ModelRouteSettings, ModelSource, Protocol } from '../lib/types'

/** A route id the user does not have to invent: from the name, else the model. */
function slug(text: string): string {
  return text.trim().toLowerCase().replace(/[^a-z0-9._:/@+-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'model'
}

export function newModelRouteId(text: string, existing: readonly string[]): string {
  const base = slug(text)
  let id = base
  for (let n = 2; existing.includes(id); n += 1) id = `${base}-${n}`
  return id
}

export function providerBaseUrl(protocol: Protocol): string {
  return protocol === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1'
}

export function RouteForm({
  route,
  existing = [],
  initial,
  onCancel,
  onSaved,
  onPersisted,
}: {
  route?: ModelRouteSettings
  existing?: readonly string[]
  initial?: ModelRouteInput
  onCancel: () => void
  onSaved: (config: ConfigSnapshot, id: string) => void
  onPersisted?: ((config: ConfigSnapshot) => void) | undefined
}) {
  const chatgpt = route?.auth === 'chatgpt' || initial?.auth === 'chatgpt'
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  const [name, setName] = useState(route?.name ?? '')
  const [model, setModel] = useState(route?.model ?? route?.id ?? initial?.model ?? '')
  const [protocol, setProtocol] = useState<Protocol | ''>(route?.protocol ?? initial?.protocol ?? '')
  const [baseUrl, setBaseUrl] = useState(route?.baseUrl ?? initial?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? '')
  const [source, setSource] = useState<ModelSource | ''>(route?.source ?? initial?.source ?? '')
  const [showKey, setShowKey] = useState(false)
  const [contextWindow, setContextWindow] = useState(route?.contextWindow !== undefined ? String(route.contextWindow) : '')
  const [vision, setVision] = useState(route?.vision ?? false)
  const [priceIn, setPriceIn] = useState(route?.pricing ? String(route.pricing.input) : '')
  const [priceCached, setPriceCached] = useState(route?.pricing?.cachedInput !== undefined ? String(route.pricing.cachedInput) : '')
  const [priceOut, setPriceOut] = useState(route?.pricing ? String(route.pricing.output) : '')
  const [currency, setCurrency] = useState(route?.pricing?.currency ?? 'USD')
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)

  const save = async () => {
    const wire = model.trim()
    if (!wire) return setError('Enter the model id the provider expects, such as deepseek-chat.')
    const window = contextWindow.trim() ? Number(contextWindow) : undefined
    if (window !== undefined && (!Number.isSafeInteger(window) || window <= 0)) return setError('Context window is a whole number of tokens.')
    const price = (text: string) => text.trim() ? Number(text) : undefined
    const prices = [price(priceIn), price(priceCached), price(priceOut)]
    if (prices.some(value => value !== undefined && (!Number.isFinite(value) || value < 0))) return setError('Prices are non-negative numbers per million tokens.')
    const [input, cachedInput, output] = prices
    if ((input === undefined) !== (output === undefined)) return setError('Enter both the input and the output price, or neither.')
    if (cachedInput !== undefined && input === undefined) return setError('Enter the input and output prices too.')
    const pricing = input !== undefined && output !== undefined
      ? { input, output, ...(cachedInput !== undefined ? { cachedInput } : {}), currency: currency.trim().toUpperCase() || 'USD' }
      : route?.pricing ? null : undefined
    if (pricing && !/^[A-Z]{3}$/.test(pricing.currency)) return setError('Currency is a three-letter code such as USD or CNY.')
    const id = route?.id ?? newModelRouteId(name || wire, existing)
    const connectionProtocol = protocol || initial?.protocol
    const endpoint = baseUrl.trim() || (!route && !initial?.sourceRouteId && connectionProtocol ? providerBaseUrl(connectionProtocol) : '')
    setBusy(true)
    setError(undefined)
    try {
      const next = await api.saveModelRoute(id, {
        name: name.trim(),
        model: wire,
        ...(!chatgpt && (!initial?.sourceRouteId || protocol) ? { protocol } : {}),
        ...(!chatgpt && (!initial?.sourceRouteId || endpoint) ? { baseUrl: endpoint } : {}),
        ...(!chatgpt && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(window !== undefined ? { contextWindow: window } : {}),
        vision,
        ...(pricing !== undefined ? { pricing } : {}),
        ...(source ? { source } : {}),
        ...(initial?.sourceRouteId ? { sourceRouteId: initial.sourceRouteId } : {}),
        ...(initial?.auth ? { auth: initial.auth } : {}),
      })
      onPersisted?.(next)
      if (active.current) onSaved(next, id)
    } catch (reason) {
      if (active.current) setError(errorText(reason))
    } finally {
      if (active.current) setBusy(false)
    }
  }

  return (
    <div className="model-route-form form-grid">
      <label className="field">
        <span className="field-label">Name</span>
        <input value={name} onChange={event => setName(event.target.value)} placeholder="DeepSeek Flash" autoFocus />
      </label>
      <label className="field">
        <span className="field-label">Model id</span>
        <input value={model} onChange={event => setModel(event.target.value)} placeholder="deepseek-chat" spellCheck={false} />
      </label>
      {chatgpt && <p className="muted small span-2">Uses your ChatGPT login. To use an API key, return to Connection and choose an API connection.</p>}
      {!chatgpt && <label className="field">
        <span className="field-label">Protocol</span>
        <select value={protocol} onChange={event => {
          const value = event.target.value
          if (value === '' || value === 'openai' || value === 'anthropic') setProtocol(value)
        }}>
          <option value="">Detect automatically</option>
          <option value="anthropic">Anthropic Messages</option>
          <option value="openai">OpenAI compatible</option>
        </select>
      </label>}
      <label className="field">
        <span className="field-label">Model source</span>
        <select value={source} onChange={event => {
          if (event.target.value === '' || event.target.value === 'provider' || event.target.value === 'third-party') setSource(event.target.value)
        }}>
          <option value="">Detect from connection</option>
          <option value="provider">Model providers</option>
          <option value="third-party">Third-party</option>
        </select>
      </label>
      <label className="field">
        <span className="field-label">Context window (tokens)</span>
        <input value={contextWindow} onChange={event => setContextWindow(event.target.value)} placeholder="Model default" inputMode="numeric" />
      </label>
      {!chatgpt && <label className="field span-2">
        <span className="field-label">Base URL</span>
        <input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://api.deepseek.com" spellCheck={false} />
      </label>}
      {!chatgpt && <label className="field span-2">
        <span className="field-label">API key</span>
        <span className="input-with-icon">
          <KeyRound size={14} />
          <input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={event => setApiKey(event.target.value)}
            placeholder={route?.apiKeySet ? 'Saved — leave empty to keep it' : 'Paste the key for this model'}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="button" className="icon-button tiny" onClick={() => setShowKey(value => !value)} aria-label={showKey ? 'Hide key' : 'Show key'}>
            {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </span>
      </label>}
      <label className="field-check span-2">
        <input type="checkbox" checked={vision} onChange={event => setVision(event.target.checked)} />
        <span>Accepts images</span>
      </label>
      <div className="field span-2" role="group" aria-label="Price per million tokens">
        <span className="field-label">Price per million tokens <span className="muted">· optional, for cost estimates</span></span>
        <div className="price-fields">
        <label><span>Input</span><input value={priceIn} onChange={event => setPriceIn(event.target.value)} inputMode="decimal" placeholder="2.00" aria-label="Input price per million tokens" /></label>
        <label><span>Cached input</span><input value={priceCached} onChange={event => setPriceCached(event.target.value)} inputMode="decimal" placeholder="Same as input" aria-label="Cached input price per million tokens" /></label>
        <label><span>Output</span><input value={priceOut} onChange={event => setPriceOut(event.target.value)} inputMode="decimal" placeholder="8.00" aria-label="Output price per million tokens" /></label>
        <label><span>Currency</span><input value={currency} onChange={event => setCurrency(event.target.value)} maxLength={3} spellCheck={false} aria-label="Currency" /></label>
        </div>
      </div>
      {error && <div className="notice notice-error span-2"><span>{error}</span></div>}
      <div className="model-route-form-actions span-2">
        <button type="button" className="button ghost small" onClick={() => { active.current = false; onCancel() }}>Cancel</button>
        <button type="button" className="button primary small" disabled={busy} onClick={() => void save()}>{route ? 'Save model' : 'Add model'}</button>
      </div>
    </div>
  )
}
