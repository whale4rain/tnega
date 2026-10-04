import { Cpu, Eye, EyeOff, Info, KeyRound, Monitor, Moon, Palette, ShieldCheck, SquareTerminal, Sun } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { api, type ConfigPatch } from '../lib/api'
import { errorText, useStoredState, type ThemePreference } from '../lib/hooks'
import type { ApprovalMode, ApprovalReviewerSettings, ConfigSnapshot, Effort, Protocol } from '../lib/types'
import { Dialog } from './Dialog'
import { ModelRoutes } from './ModelRoutes'
import { UpdateSettings } from './UpdateButton'
import type { DesktopUpdates } from '../lib/desktop-updates'

/**
 * Settings are grouped into sections listed in the left rail. A new option
 * belongs in the section it configures; a new area of settings is one more
 * entry in `SECTIONS` plus its panel below. Form fields are saved together
 * with "Save changes"; appearance and updates apply immediately.
 */
type SectionId = 'model' | 'approvals' | 'tools' | 'appearance' | 'about'

const SECTIONS: ReadonlyArray<{ id: SectionId; label: string; description: string; icon: typeof Cpu }> = [
  { id: 'model', label: 'Models', description: 'Chat models that run sessions, projects and threads. Register several, choose the default, and switch per session from the composer. Approval reviewers such as TypeSafe Jev are not chat models; set them under Approvals.', icon: Cpu },
  { id: 'approvals', label: 'Approvals', description: 'Who reviews actions that need permission.', icon: ShieldCheck },
  { id: 'tools', label: 'Tools & shell', description: 'How the agent runs commands and calls its tools.', icon: SquareTerminal },
  { id: 'appearance', label: 'Appearance', description: 'How Tnega looks on this device.', icon: Palette },
  { id: 'about', label: 'About & updates', description: 'Version, updates and where settings are stored.', icon: Info },
]

const SECTION_IDS = SECTIONS.map(section => section.id)

export function SettingsDialog({
  config,
  updates,
  theme,
  onThemeChange,
  onClose,
  onSaved,
}: {
  config: ConfigSnapshot | undefined
  updates?: DesktopUpdates | undefined
  theme?: ThemePreference
  onThemeChange?: (theme: ThemePreference) => void
  onClose: () => void
  onSaved: (config: ConfigSnapshot) => void
}) {
  const stored = config?.config
  const [section, setSection] = useStoredState<SectionId>('tnega.settingsSection', 'model', SECTION_IDS)
  const [codeMode, setCodeMode] = useState(stored?.codeMode ?? false)
  const [shell, setShell] = useState(stored?.shell ?? '')
  const [protocol, setProtocol] = useState<'' | Protocol>(stored?.protocol ?? '')
  const [baseUrl, setBaseUrl] = useState(stored?.baseUrl ?? '')
  const [model, setModel] = useState(stored?.model ?? '')
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [effort, setEffort] = useState<'' | Effort>(stored?.reasoningEffort ?? '')
  const [temperature, setTemperature] = useState(stored?.temperature !== undefined ? String(stored.temperature) : '')
  const [reviewProvider, setReviewProvider] = useState<ApprovalReviewerSettings['provider']>(stored?.approvalReview?.provider ?? 'conversation')
  const [reviewDefault, setReviewDefault] = useState<ApprovalMode>(stored?.approvalReview?.defaultMode ?? 'manual')
  const [reviewModelId, setReviewModelId] = useState(stored?.approvalReview?.modelId ?? '')
  const [reviewModel, setReviewModel] = useState(stored?.approvalReview?.model ?? '')
  const [reviewBaseUrl, setReviewBaseUrl] = useState(stored?.approvalReview?.baseUrl ?? '')
  const [reviewKey, setReviewKey] = useState('')
  const [reviewKeyEnv, setReviewKeyEnv] = useState(stored?.approvalReview?.apiKeyEnv ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const fail = (message: string, where: SectionId) => {
    setError(message)
    setSection(where)
    setSaving(false)
  }

  const save = async () => {
    setSaving(true)
    setError(undefined)
    const patch: ConfigPatch = { codeMode, shell, protocol, baseUrl: baseUrl.trim(), model: model.trim(), reasoningEffort: effort }
    patch.approvalReview = {
      provider: reviewProvider, defaultMode: reviewDefault,
      modelId: reviewModelId.trim(), model: reviewModel.trim(), baseUrl: reviewBaseUrl.trim(), apiKeyEnv: reviewKeyEnv.trim(),
      ...(reviewKey.trim() ? { apiKey: reviewKey.trim() } : {}),
    }
    if (apiKey.trim()) patch.apiKey = apiKey.trim()
    if (temperature.trim()) {
      const value = Number(temperature)
      if (!Number.isFinite(value)) return fail('Temperature must be a number', 'model')
      patch.temperature = value
    }
    if (reviewProvider === 'model' && !reviewModelId) return fail('Select a configured model route for automatic review', 'approvals')
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
  const current = SECTIONS.find(entry => entry.id === section) ?? SECTIONS[0]!
  const panel = (id: SectionId, children: ReactNode) => (
    <section
      key={id}
      id={`settings-panel-${id}`}
      role="tabpanel"
      aria-labelledby={`settings-tab-${id}`}
      className="settings-panel"
      hidden={section !== id}
    >
      {children}
    </section>
  )

  return (
    <Dialog
      title="Settings"
      width={920}
      onClose={onClose}
      footer={
        <>
          {error && <span className="form-error" role="alert">{error}</span>}
          <button type="button" className="button ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="button primary" onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button>
        </>
      }
    >
      {config?.problem && (
        <div className="notice notice-error" role="alert">
          The config file could not be read, so nothing will be saved over it: {config.problem}
        </div>
      )}
      <div className="settings-layout">
        <nav className="settings-nav" role="tablist" aria-orientation="vertical" aria-label="Settings sections">
          {SECTIONS.map(entry => {
            const Icon = entry.icon
            return (
              <button
                key={entry.id}
                id={`settings-tab-${entry.id}`}
                type="button"
                role="tab"
                aria-selected={section === entry.id}
                aria-controls={`settings-panel-${entry.id}`}
                className={`settings-nav-item${section === entry.id ? ' active' : ''}`}
                onClick={() => setSection(entry.id)}
              >
                <Icon size={15} aria-hidden />{entry.label}
              </button>
            )
          })}
        </nav>
        <div className="settings-content">
          <header className="settings-content-header">
            <h3>{current.label}</h3>
            <p className="muted small">{current.description}</p>
          </header>

          {panel('model', <>
            {config && (
              <ModelRoutes
                config={config}
                defaultId={model.trim() || effective?.modelId || ''}
                onDefault={setModel}
                onChanged={onSaved}
              />
            )}
            {!stored?.models?.length && effective && (
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
              {!stored?.models?.length && <>
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
              </>}
              <label className="field">
                <span className="field-label">Reasoning effort (all models)</span>
                <select value={effort} onChange={event => setEffort(event.target.value as '' | Effort)}>
                  <option value="">Model default</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </label>
              <label className="field">
                <span className="field-label">Temperature (all models)</span>
                <input value={temperature} onChange={event => setTemperature(event.target.value)} placeholder="Model default" inputMode="decimal" />
              </label>
            </div>
          </>)}

          {panel('approvals', <div className="form-grid">
            <label className="field">
              <span className="field-label">Approval reviewer</span>
              <select value={reviewProvider} onChange={event => {
                const value = event.target.value
                if (value === 'conversation' || value === 'model' || value === 'jev' || value === 'openai') {
                  setReviewProvider(value)
                  setReviewModel('')
                  setReviewBaseUrl('')
                  setReviewKey('')
                  setReviewKeyEnv('')
                }
              }}>
                <option value="conversation">Conversation model</option>
                <option value="model">Configured model route</option>
                <option value="jev">TypeSafe Jev</option>
                <option value="openai">OpenAI Responses</option>
              </select>
            </label>
            <label className="field">
              <span className="field-label">Default approvals</span>
              <select value={reviewDefault} onChange={event => { if (event.target.value === 'manual' || event.target.value === 'auto') setReviewDefault(event.target.value) }}>
                <option value="manual">Ask me</option>
                <option value="auto">Auto review</option>
              </select>
            </label>
            {reviewProvider === 'model' && <label className="field span-2">
              <span className="field-label">Reviewer model route</span>
              <select value={reviewModelId} onChange={event => setReviewModelId(event.target.value)}>
                <option value="">Choose a route</option>
                {config?.models.map(route => <option key={route.id} value={route.id}>{route.name}</option>)}
              </select>
            </label>}
            {(reviewProvider === 'jev' || reviewProvider === 'openai') && <>
              <label className="field"><span className="field-label">Reviewer model</span><input value={reviewModel} onChange={event => setReviewModel(event.target.value)} placeholder={reviewProvider === 'jev' ? 'jev-latest' : 'gpt-6.1-sol'} spellCheck={false} /></label>
              <label className="field"><span className="field-label">API key environment variable</span><input value={reviewKeyEnv} onChange={event => setReviewKeyEnv(event.target.value)} placeholder={reviewProvider === 'jev' ? 'TYPESAFE_API_KEY' : 'OPENAI_API_KEY'} spellCheck={false} /></label>
              <label className="field span-2"><span className="field-label">Reviewer endpoint</span><input value={reviewBaseUrl} onChange={event => setReviewBaseUrl(event.target.value)} placeholder={reviewProvider === 'jev' ? 'https://api.typesafe.ai/v1' : 'https://api.openai.com/v1'} spellCheck={false} /></label>
              <label className="field span-2"><span className="field-label">Reviewer API key</span><input type="password" value={reviewKey} onChange={event => setReviewKey(event.target.value)} placeholder={stored?.approvalReview?.apiKeySet ? 'Saved — leave empty to keep it' : 'Separate credential or environment variable'} autoComplete="off" /></label>
            </>}
            <p className="muted small span-2">Auto review keeps your selected permissions. Uncertain or unavailable reviews return to you. Applies to Project threads by default; sessions can choose their own approval mode.</p>
          </div>)}

          {panel('tools', <div className="form-grid">
            <label className="field span-2">
              <span className="field-label">Shell</span>
              <select aria-label="Shell" value={shell} onChange={event => setShell(event.target.value)}>
                <option value="">Automatic{config?.shell?.active && !stored?.shell ? ` · ${config.shell.active}` : ''}</option>
                {config?.shell?.available.map(option => <option key={option.path} value={option.path}>{option.label} · {option.path}</option>)}
                {shell && !config?.shell?.available.some(option => option.path === shell) && <option value={shell}>{shell}</option>}
              </select>
              <span className="muted small">Used by the shell and background-process tools. The agent is told which syntax to write. Git Bash cannot run inside the Windows sandbox; choose it only with full access.</span>
            </label>
            <label className="field span-2">
              <span className="field-label">CodeMode</span>
              <select aria-label="CodeMode" value={codeMode ? 'enabled' : 'disabled'} onChange={event => setCodeMode(event.target.value === 'enabled')}>
                <option value="disabled">关闭 · 原生工具</option>
                <option value="enabled">开启 · 仅 run_code</option>
              </select>
              <span className="muted small">开启后模型只看到 run_code，通过代码调用原有工具。关闭后仅使用原生工具。保存后于下一次运行生效。</span>
            </label>
          </div>)}

          {panel('appearance', <div className="form-grid">
            <div className="field span-2">
              <span className="field-label" id="settings-theme-label">Theme</span>
              <div className="settings-choice-row" role="radiogroup" aria-labelledby="settings-theme-label">
                {([['system', 'System', Monitor], ['light', 'Light', Sun], ['dark', 'Dark', Moon]] as const).map(([value, label, Icon]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={theme === value}
                    className={`settings-choice${theme === value ? ' active' : ''}`}
                    disabled={!onThemeChange}
                    onClick={() => onThemeChange?.(value)}
                  >
                    <Icon size={15} aria-hidden />{label}
                  </button>
                ))}
              </div>
              <span className="muted small">Applies right away on this device.</span>
            </div>
          </div>)}

          {panel('about', <>
            {updates
              ? <UpdateSettings updates={updates} />
              : <p className="muted small">This is the Web interface. Update the CLI with <code>npm install -g tnega</code>; the desktop app updates itself.</p>}
            <div className="effective-card">
              <div className="effective-row"><span>Config file</span><strong className="mono" title={stored?.path}>{stored?.path ?? '~/.tnega/config.json'}</strong></div>
            </div>
          </>)}
        </div>
      </div>
    </Dialog>
  )
}
