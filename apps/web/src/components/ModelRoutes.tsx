import { Eye, EyeOff, KeyRound, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { api } from '../lib/api'
import { confirmDialog } from '../lib/dialogs'
import { errorText } from '../lib/hooks'
import type { ConfigSnapshot, ModelOption, ModelRouteSettings, Protocol } from '../lib/types'

/**
 * Chat models: every model route you registered, which one sessions start
 * with, and a form to add or change one. Routes save on their own; the
 * default is chosen here and saved with the rest of Settings.
 */
export function ModelRoutes({
  config,
  defaultId,
  onDefault,
  onChanged,
}: {
  config: ConfigSnapshot
  /** The route chosen as default (pending until Settings is saved). */
  defaultId: string
  onDefault: (id: string) => void
  onChanged: (config: ConfigSnapshot) => void
}) {
  const [editing, setEditing] = useState<string | 'new' | undefined>()
  const [error, setError] = useState<string | undefined>()
  const routes = config.config.models ?? []

  const remove = async (route: ModelRouteSettings) => {
    if (!await confirmDialog({ title: `Remove ${route.name ?? route.id}?`, message: 'Sessions that use it switch to the default model.', confirmLabel: 'Remove', danger: true })) return
    try {
      onChanged(await api.removeModelRoute(route.id))
      setError(undefined)
    } catch (reason) {
      setError(errorText(reason))
    }
  }

  return (
    <div className="model-routes">
      <div className="model-route-list" role="radiogroup" aria-label="Default model">
        {config.models.map(option => {
          const route = routes.find(entry => entry.id === option.id)
          return (
            <div key={option.id} className={`model-route${defaultId === option.id ? ' is-default' : ''}`}>
              <label className="model-route-main">
                <input type="radio" name="default-model" checked={defaultId === option.id} onChange={() => onDefault(option.id)} />
                <span className="model-route-text">
                  <span className="model-route-name">{option.name}</span>
                  <span className="model-route-meta">{routeMeta(option, route)}</span>
                </span>
              </label>
              <span className="model-route-badges">
                {defaultId === option.id && <span className="model-chip accent">Default</span>}
                {option.vision && <span className="model-chip">Images</span>}
                {option.contextWindow !== undefined && <span className="model-chip">{Math.round(option.contextWindow / 1000)}k</span>}
                {!option.apiKeySet && <span className="model-chip danger">No key</span>}
              </span>
              {route && (
                <span className="model-route-actions">
                  <button type="button" className="icon-button tiny" aria-label={`Edit ${option.name}`} title="Edit" onClick={() => setEditing(option.id)}><Pencil size={13} /></button>
                  <button type="button" className="icon-button tiny" aria-label={`Remove ${option.name}`} title="Remove" onClick={() => void remove(route)}><Trash2 size={13} /></button>
                </span>
              )}
              {editing === option.id && route && (
                <RouteForm route={route} onCancel={() => setEditing(undefined)} onSaved={next => { onChanged(next); setEditing(undefined) }} />
              )}
            </div>
          )
        })}
      </div>
      {error && <div className="notice notice-error"><span>{error}</span></div>}
      {editing === 'new'
        ? <RouteForm existing={config.models.map(option => option.id)} onCancel={() => setEditing(undefined)} onSaved={next => { onChanged(next); setEditing(undefined) }} />
        : <button type="button" className="button secondary small" onClick={() => setEditing('new')}><Plus size={13} /> Add model</button>}
    </div>
  )
}

function routeMeta(option: ModelOption, route: ModelRouteSettings | undefined): string {
  const wire = route?.model && route.model !== option.name ? route.model : option.id !== option.name ? option.id : undefined
  let host: string | undefined
  try {
    host = route?.baseUrl ? new URL(route.baseUrl).host : undefined
  } catch {
    host = route?.baseUrl
  }
  const protocol = option.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI compatible'
  return [wire, host, protocol].filter(Boolean).join(' · ')
}

/** A route id the user does not have to invent: from the name, else the model. */
function slug(text: string): string {
  return text.trim().toLowerCase().replace(/[^a-z0-9._:/@+-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'model'
}

function RouteForm({
  route,
  existing = [],
  onCancel,
  onSaved,
}: {
  route?: ModelRouteSettings
  existing?: readonly string[]
  onCancel: () => void
  onSaved: (config: ConfigSnapshot) => void
}) {
  const [name, setName] = useState(route?.name ?? '')
  const [model, setModel] = useState(route?.model ?? route?.id ?? '')
  const [protocol, setProtocol] = useState<Protocol | ''>(route?.protocol ?? '')
  const [baseUrl, setBaseUrl] = useState(route?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState('')
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
    let id = route?.id ?? slug(name || wire)
    if (!route) for (let n = 2; existing.includes(id); n += 1) id = `${slug(name || wire)}-${n}`
    setBusy(true)
    setError(undefined)
    try {
      onSaved(await api.saveModelRoute(id, {
        name: name.trim(),
        model: wire,
        protocol,
        baseUrl: baseUrl.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(window !== undefined ? { contextWindow: window } : {}),
        vision,
        ...(pricing !== undefined ? { pricing } : {}),
      }))
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(false)
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
      <label className="field">
        <span className="field-label">Protocol</span>
        <select value={protocol} onChange={event => setProtocol(event.target.value as Protocol | '')}>
          <option value="">Detect automatically</option>
          <option value="anthropic">Anthropic Messages</option>
          <option value="openai">OpenAI compatible</option>
        </select>
      </label>
      <label className="field">
        <span className="field-label">Context window (tokens)</span>
        <input value={contextWindow} onChange={event => setContextWindow(event.target.value)} placeholder="Model default" inputMode="numeric" />
      </label>
      <label className="field span-2">
        <span className="field-label">Base URL</span>
        <input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://api.deepseek.com" spellCheck={false} />
      </label>
      <label className="field span-2">
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
      </label>
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
        <button type="button" className="button ghost small" onClick={onCancel}>Cancel</button>
        <button type="button" className="button primary small" disabled={busy} onClick={() => void save()}>{route ? 'Save model' : 'Add model'}</button>
      </div>
    </div>
  )
}
