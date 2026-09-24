import { useState, useEffect } from 'react'
import { Button, Select, TextField } from '@radix-ui/themes'
import * as api from '../api'
import type { ConfigSnapshot } from '../types'

interface SettingsViewProps {
  config: ConfigSnapshot | null
  onSaved: (config: ConfigSnapshot) => void
  onReload: (config: ConfigSnapshot) => void
}

export function SettingsView({ config, onSaved, onReload }: SettingsViewProps) {
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [temperature, setTemperature] = useState('')
  const [protocol, setProtocol] = useState<'auto' | 'openai' | 'anthropic'>('auto')
  const [reasoningEffort, setReasoningEffort] = useState<'default' | 'low' | 'medium' | 'high'>('default')
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const supportedEfforts = config?.models.find(item => item.id === model)?.reasoningEfforts ?? []
  const selectedEffort = reasoningEffort !== 'default' && supportedEfforts.includes(reasoningEffort)
    ? reasoningEffort : 'default'

  useEffect(() => {
    if (!config) return
    setBaseUrl(config.config.baseUrl ?? config.effective.baseUrl)
    setModel(config.config.model ?? config.effective.modelId)
    setProtocol(config.config.protocol ?? 'auto')
    setReasoningEffort(config.config.reasoningEffort ?? 'default')
    setTemperature(
      config.config.temperature === undefined
        ? ''
        : String(config.config.temperature),
    )
  }, [config])

  async function submit() {
    if (!config || busy) return
    setBusy(true)
    setError(null)
    const patch: Record<string, unknown> = {}
    if (apiKey.trim()) patch.apiKey = apiKey.trim()
    if (baseUrl.trim()) patch.baseUrl = baseUrl.trim()
    else patch.baseUrl = ''
    if (model.trim()) patch.model = model.trim()
    else patch.model = ''
    patch.protocol = protocol === 'auto' ? '' : protocol
    patch.reasoningEffort = selectedEffort === 'default' ? '' : selectedEffort
    if (temperature.trim()) {
      const value = Number(temperature)
      if (Number.isFinite(value)) patch.temperature = value
    }
    try {
      const next = await api.saveConfig(patch)
      onSaved(next)
      setApiKey('')
      setSaved(true)
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }

  async function reload() {
    try {
      setError(null)
      onReload(await api.getConfig())
    } catch (reason) {
      setError(messageOf(reason))
    }
  }

  return (
    <div className="settings">
      <div className="settings-header">
        <span>Model settings</span>
        <span className="count">
          {config?.apiKeySet ? 'key set' : 'key not set'}
        </span>
      </div>
      <div className="settings-grid">
        <label className="field">
          <span>API key</span>
          <TextField.Root
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={config?.apiKeySet ? '********' : 'not set'}
            autoComplete="off"
            spellCheck={false}
          />
          <span className="field-note">
            {config?.apiKeySet ? '[set]' : '[not set]'}
          </span>
        </label>
        <label className="field">
          <span>Base URL</span>
          <TextField.Root
            type="text"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            spellCheck={false}
          />
          <span className="field-note">
            env: {config?.env.baseUrl ?? 'none'}
          </span>
        </label>
        <label className="field">
          <span>Model</span>
          <TextField.Root
            type="text"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            list="model-options"
            spellCheck={false}
          />
          <datalist id="model-options">
            {config?.models.map((option) => (
              <option key={option.id} value={option.id} />
            ))}
          </datalist>
          <span className="field-note">env: {config?.env.model ?? 'none'}</span>
        </label>
        <label className="field">
          <span>Protocol</span>
          <Select.Root value={protocol} onValueChange={value => {
            if (value === 'auto' || value === 'openai' || value === 'anthropic') setProtocol(value)
          }}>
            <Select.Trigger aria-label="Model protocol" />
            <Select.Content>
              <Select.Item value="auto">Auto</Select.Item>
              <Select.Item value="openai">OpenAI compatible</Select.Item>
              <Select.Item value="anthropic">Anthropic compatible</Select.Item>
            </Select.Content>
          </Select.Root>
        </label>
        <label className="field">
          <span>Default thinking</span>
          <Select.Root value={selectedEffort} onValueChange={value => {
            if (value === 'default' || value === 'low' || value === 'medium' || value === 'high') setReasoningEffort(value)
          }} disabled={supportedEfforts.length === 0}>
            <Select.Trigger aria-label="Default thinking effort" />
            <Select.Content>
              <Select.Item value="default">Model default</Select.Item>
              {supportedEfforts.map(effort => <Select.Item key={effort} value={effort}>{effort}</Select.Item>)}
            </Select.Content>
          </Select.Root>
          <span className="field-note">Applied only when the model supports effort.</span>
        </label>
        <label className="field">
          <span>Temperature</span>
          <TextField.Root
            type="number"
            step="0.1"
            min="0"
            max="2"
            value={temperature}
            onChange={(event) => setTemperature(event.target.value)}
            placeholder={
              config?.effective.temperature === undefined
                ? 'default'
                : String(config.effective.temperature)
            }
          />
          <span className="field-note">
            effective: {config?.effective.model ?? '-'}
          </span>
        </label>
      </div>
      <div className="settings-profiles">
        <div className="settings-profiles-heading">
          <strong>Selectable models</strong>
          <Button size="1" variant="ghost" color="gray" onClick={() => void reload()}>Reload file</Button>
        </div>
        <p>Configure multiple model routes in the <code>models</code> array of:</p>
        <code className="settings-config-path">{config?.config.path ?? 'Loading…'}</code>
        <div className="settings-model-list">
          {config?.models.map(item => (
            <div key={item.id} className="settings-model-row">
              <span>{item.name}</span>
              <span>{item.reasoningEfforts.length ? item.reasoningEfforts.join(' · ') : 'model default'}</span>
            </div>
          ))}
        </div>
      </div>
      {error && (
        <div className="error-banner" role="alert">
          <span className="marker">[!]</span>
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} title="dismiss">
            [x]
          </button>
        </div>
      )}
      <div className="settings-actions">
        <Button
          type="button"
          className="button-primary"
          onClick={() => void submit()}
          disabled={busy || !config}
        >
          {busy ? 'Saving…' : 'Save settings'}
        </Button>
        {saved && <span className="saved-note">saved</span>}
      </div>
    </div>
  )
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
