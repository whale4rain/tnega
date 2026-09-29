import { Eye, EyeOff, KeyRound } from 'lucide-react'
import { useState } from 'react'
import { api, type ConfigPatch } from '../lib/api'
import { errorText } from '../lib/hooks'
import type { ConfigSnapshot, Effort, Protocol } from '../lib/types'
import { Dialog } from './Dialog'

export function SettingsDialog({
  config,
  onClose,
  onSaved,
}: {
  config: ConfigSnapshot | undefined
  onClose: () => void
  onSaved: (config: ConfigSnapshot) => void
}) {
  const stored = config?.config
  const [protocol, setProtocol] = useState<'' | Protocol>(stored?.protocol ?? '')
  const [baseUrl, setBaseUrl] = useState(stored?.baseUrl ?? '')
  const [model, setModel] = useState(stored?.model ?? '')
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [effort, setEffort] = useState<'' | Effort>(stored?.reasoningEffort ?? '')
  const [temperature, setTemperature] = useState(stored?.temperature !== undefined ? String(stored.temperature) : '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const save = async () => {
    setSaving(true)
    setError(undefined)
    const patch: ConfigPatch = { protocol, baseUrl: baseUrl.trim(), model: model.trim(), reasoningEffort: effort }
    if (apiKey.trim()) patch.apiKey = apiKey.trim()
    if (temperature.trim()) {
      const value = Number(temperature)
      if (!Number.isFinite(value)) {
        setError('Temperature must be a number')
        setSaving(false)
        return
      }
      patch.temperature = value
    }
    try {
      onSaved(await api.saveConfig(patch))
      onClose()
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setSaving(false)
    }
  }

  const effective = config?.effective
  return (
    <Dialog
      title="Settings"
      description={<>Model connection used by every session. Saved to <code>{stored?.path ?? '~/.tnega/config.json'}</code>.</>}
      onClose={onClose}
      footer={
        <>
          {error && <span className="form-error">{error}</span>}
          <button type="button" className="button ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="button primary" onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button>
        </>
      }
    >
      {effective && (
        <div className="effective-card">
          <div className="effective-row"><span>Active model</span><strong>{effective.modelId || effective.model || '—'}</strong></div>
          <div className="effective-row"><span>Endpoint</span><strong className="mono">{effective.baseUrl || 'provider default'}</strong></div>
          <div className="effective-row">
            <span>API key</span>
            <strong className={config.apiKeySet ? 'ok' : 'danger'}>{config.apiKeySet ? (config.env.apiKeySet && !config.config.apiKeySet ? 'From environment' : 'Configured') : 'Missing'}</strong>
          </div>
        </div>
      )}

      <div className="form-grid">
        <label className="field">
          <span className="field-label">Protocol</span>
          <select value={protocol} onChange={event => setProtocol(event.target.value as '' | Protocol)}>
            <option value="">Detect automatically</option>
            <option value="anthropic">Anthropic Messages</option>
            <option value="openai">OpenAI compatible</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">Model</span>
          <input value={model} onChange={event => setModel(event.target.value)} placeholder={effective?.model || 'e.g. claude-sonnet-5-5'} spellCheck={false} />
        </label>
        <label className="field span-2">
          <span className="field-label">Base URL</span>
          <input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder={effective?.baseUrl || 'https://api.anthropic.com'} spellCheck={false} />
        </label>
        <label className="field span-2">
          <span className="field-label">API key</span>
          <span className="input-with-icon">
            <KeyRound size={14} />
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={event => setApiKey(event.target.value)}
              placeholder={stored?.apiKeySet ? 'Saved — leave empty to keep it' : 'Paste your key'}
              autoComplete="off"
              spellCheck={false}
            />
            <button type="button" className="icon-button tiny" onClick={() => setShowKey(v => !v)} aria-label={showKey ? 'Hide key' : 'Show key'}>
              {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </span>
        </label>
        <label className="field">
          <span className="field-label">Reasoning effort</span>
          <select value={effort} onChange={event => setEffort(event.target.value as '' | Effort)}>
            <option value="">Model default</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">Temperature</span>
          <input value={temperature} onChange={event => setTemperature(event.target.value)} placeholder="Model default" inputMode="decimal" />
        </label>
      </div>
      {config && config.models.length > 1 && (
        <p className="muted small">
          {config.models.length} model routes are configured in the config file; pick one per session from the composer.
        </p>
      )}
    </Dialog>
  )
}
