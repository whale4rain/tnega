import { useState, useEffect } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { NumberInput } from '@astryxdesign/core/NumberInput'
import { Selector } from '@astryxdesign/core/Selector'
import { TextInput } from '@astryxdesign/core/TextInput'
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
  const [temperature, setTemperature] = useState<number | null>(null)
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
    setTemperature(config.config.temperature ?? null)
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
    // An empty field means "leave it to the provider", so nothing is sent for it.
    if (temperature !== null) patch.temperature = temperature
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
        <TextInput
          label="API key"
          type="password"
          value={apiKey}
          onChange={setApiKey}
          placeholder={config?.apiKeySet ? '********' : 'not set'}
          autoComplete="off"
          description={config?.apiKeySet ? '[set]' : '[not set]'}
        />
        <TextInput
          label="Base URL"
          value={baseUrl}
          onChange={setBaseUrl}
          description={`env: ${config?.env.baseUrl ?? 'none'}`}
        />
        <TextInput
          label="Model"
          value={model}
          onChange={setModel}
          description={`env: ${config?.env.model ?? 'none'}`}
        />
        <Selector
          label="Protocol"
          value={protocol}
          options={[
            { value: 'auto', label: 'Auto' },
            { value: 'openai', label: 'OpenAI compatible' },
            { value: 'anthropic', label: 'Anthropic compatible' },
          ]}
          onChange={value => {
            if (value === 'auto' || value === 'openai' || value === 'anthropic') setProtocol(value)
          }}
        />
        <Selector
          label="Default thinking"
          value={selectedEffort}
          isDisabled={supportedEfforts.length === 0}
          options={[
            { value: 'default', label: 'Model default' },
            ...supportedEfforts.map(effort => ({ value: effort, label: effort })),
          ]}
          onChange={value => {
            if (value === 'default' || value === 'low' || value === 'medium' || value === 'high') setReasoningEffort(value)
          }}
          description="Applied only when the model supports effort."
        />
        <NumberInput
          label="Temperature"
          value={temperature}
          onChange={setTemperature}
          min={0}
          max={2}
          step={0.1}
          placeholder={
            config?.effective.temperature === undefined
              ? 'default'
              : String(config.effective.temperature)
          }
          description={`effective: ${config?.effective.model ?? '-'}`}
        />
      </div>
      <div className="settings-profiles">
        <div className="settings-profiles-heading">
          <strong>Selectable models</strong>
          <Button label="Reload file" variant="ghost" size="sm" onClick={() => void reload()} />
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
          <Button label="Dismiss" variant="ghost" size="sm" onClick={() => setError(null)} />
        </div>
      )}
      <div className="settings-actions">
        <Button
          className="button-primary"
          label={busy ? 'Saving…' : 'Save settings'}
          onClick={() => void submit()}
          isDisabled={busy || !config}
        />
        {saved && <span className="saved-note">saved</span>}
      </div>
    </div>
  )
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
