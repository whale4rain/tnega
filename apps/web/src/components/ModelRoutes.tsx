import { Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { api } from '../lib/api'
import { confirmDialog } from '../lib/dialogs'
import { errorText } from '../lib/hooks'
import type { ConfigSnapshot, ModelOption, ModelRouteSettings } from '../lib/types'
import { ChatGptSignIn } from './ChatGptSignIn'
import { ModelBrowser } from './ModelBrowser'
import { RouteForm } from './ModelRouteForm'

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
  const [connection, setConnection] = useState<string>()
  const routes = config.config.models ?? []
  const groups = (['provider', 'third-party'] as const).map(source => ({
    source, label: source === 'provider' ? 'Model providers' : 'Third-party',
    models: config.models.filter(option => (option.source ?? 'third-party') === source),
  })).filter(group => group.models.length)

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
        {groups.map(group => <div key={group.source} role="group" aria-label={group.label}>
          <div className="menu-heading">{group.label}</div>
          {group.models.map(option => {
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
                  <button type="button" className="icon-button tiny" aria-label={`Get models from ${option.name}`} title="Get models" onClick={() => { setConnection(`route:${option.id}`); setEditing('new') }}><RefreshCw size={12} /></button>
                  <button type="button" className="icon-button tiny" aria-label={`Edit ${option.name}`} title="Edit" onClick={() => setEditing(option.id)}><Pencil size={12} /></button>
                  <button type="button" className="icon-button tiny" aria-label={`Remove ${option.name}`} title="Remove" onClick={() => void remove(route)}><Trash2 size={12} /></button>
                </span>
              )}
              {editing === option.id && route && (
                <RouteForm route={route} onCancel={() => setEditing(undefined)} onPersisted={onChanged} onSaved={() => setEditing(undefined)} />
              )}
            </div>
          )
        })}</div>)}
      </div>
      {error && <div className="notice notice-error"><span>{error}</span></div>}
      <ChatGptSignIn onChanged={onChanged} onGetModels={() => { setConnection('chatgpt'); setEditing('new') }} />
      {editing === 'new'
        ? <ModelBrowser config={config} initialConnection={connection} onCancel={() => setEditing(undefined)} onPersisted={onChanged} onSaved={() => setEditing(undefined)} />
        : <button type="button" className="button secondary small" onClick={() => { setConnection(undefined); setEditing('new') }}><Plus size={12} /> Add model</button>}
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
  if (route?.auth === 'chatgpt') return [wire, 'ChatGPT sign-in'].filter(Boolean).join(' · ')
  const protocol = option.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI compatible'
  return [wire, host, protocol].filter(Boolean).join(' · ')
}
