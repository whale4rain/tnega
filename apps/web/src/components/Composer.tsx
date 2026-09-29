import { ArrowUp, Code2, Gauge, MessageSquare, ShieldAlert, ShieldCheck, ShieldHalf, Sparkles, Square, Target, ListChecks, Zap, Cpu } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AgentType, Effort, ModelOption, Permission, SessionEffort, SessionMode, SlashCommand } from '../lib/types'
import { Choice, type ChoiceOption } from './Menu'

export interface RunSettings {
  agentType: AgentType
  mode: SessionMode
  permission: Permission
  model?: string | undefined
  reasoningEffort: SessionEffort
}

export const AGENT_OPTIONS: ReadonlyArray<ChoiceOption<AgentType>> = [
  { value: 'coding', label: 'Coding', description: 'Workspace-aware engineer with skills, plans and slash commands', icon: <Code2 size={14} /> },
  { value: 'general', label: 'General', description: 'A plain assistant with the standard tool set', icon: <MessageSquare size={14} /> },
]

export const MODE_OPTIONS: ReadonlyArray<ChoiceOption<SessionMode>> = [
  { value: 'auto', label: 'Auto', description: 'Work on the request directly', icon: <Zap size={14} /> },
  { value: 'plan', label: 'Plan', description: 'Draft a step-by-step plan first', icon: <ListChecks size={14} /> },
  { value: 'goal', label: 'Goal', description: 'Keep going across rounds until the goal is met', icon: <Target size={14} /> },
]

export const PERMISSION_OPTIONS: ReadonlyArray<ChoiceOption<Permission>> = [
  { value: 'read-only', label: 'Read only', description: 'Ask before any write, shell or private network access', icon: <ShieldCheck size={14} /> },
  { value: 'workspace-write', label: 'Workspace write', description: 'Edit files inside this workspace without asking', icon: <ShieldHalf size={14} /> },
  { value: 'bypass', label: 'Full access', description: 'No sandbox; can touch files outside the workspace', icon: <ShieldAlert size={14} />, tone: 'danger' },
]

export const EFFORT_LABEL: Record<SessionEffort, string> = { default: 'Default effort', low: 'Low effort', medium: 'Medium effort', high: 'High effort' }

export function modelOptions(models: ModelOption[], defaultModelId: string | undefined): Array<ChoiceOption<string>> {
  return [
    { value: '', label: 'Default model', description: defaultModelId ? `Currently ${defaultModelId}` : 'Use the configured default', icon: <Cpu size={14} /> },
    ...models.map(model => ({
      value: model.id,
      label: model.name || model.id,
      description: `${model.protocol}${model.contextWindow ? ` · ${Math.round(model.contextWindow / 1000)}k context` : ''}${model.apiKeySet ? '' : ' · no API key'}`,
      icon: <Cpu size={14} />,
    })),
  ]
}

/**
 * The message box itself: auto-growing input, optional slash-command
 * completion, a toolbar slot and a send / stop button.
 */
export function PromptBox({
  commands = [],
  running = false,
  disabledReason,
  onSubmit,
  onStop,
  placeholder,
  toolbar,
  footer,
  autoFocusKey,
  compact,
}: {
  commands?: SlashCommand[]
  running?: boolean
  disabledReason?: ReactNode
  onSubmit: (text: string) => Promise<boolean> | boolean
  /** When given, the send button becomes a stop button while `running`. */
  onStop?: (() => void) | undefined
  placeholder: string
  toolbar?: ReactNode
  footer?: ReactNode
  autoFocusKey?: string | undefined
  compact?: boolean
}) {
  const [text, setText] = useState('')
  const [slashIndex, setSlashIndex] = useState(0)
  const input = useRef<HTMLTextAreaElement>(null)
  const showStop = running && Boolean(onStop)

  const maxHeight = compact ? 180 : 280
  const fit = useCallback(() => {
    const el = input.current
    // Without a width (hidden or not laid out yet) the text would wrap per character.
    if (!el || el.clientWidth === 0) return
    el.style.height = '0px'
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
  }, [maxHeight])

  useLayoutEffect(fit, [text, fit])

  // The height depends on width too (wrapping), so refit when the box resizes.
  useEffect(() => {
    const el = input.current
    if (!el) return
    const frame = requestAnimationFrame(fit)
    void document.fonts?.ready.then(fit)
    const parent = el.parentElement
    const observer = typeof ResizeObserver === 'undefined' || !parent ? undefined : new ResizeObserver(fit)
    if (parent) observer?.observe(parent)
    return () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
    }
  }, [fit])

  useEffect(() => {
    input.current?.focus()
  }, [autoFocusKey])

  const slashQuery = /^\/\S*$/.test(text) ? text.slice(1).toLowerCase() : undefined
  const suggestions = useMemo(() => {
    if (slashQuery === undefined || !commands.length) return []
    return commands.filter(command => command.name.replace(/^\//, '').toLowerCase().startsWith(slashQuery)).slice(0, 8)
  }, [commands, slashQuery])
  useEffect(() => setSlashIndex(0), [slashQuery])

  const submit = async () => {
    const value = text.trim()
    if (!value || showStop || disabledReason) return
    const accepted = await onSubmit(value)
    if (accepted) setText('')
  }

  return (
    <div className={`composer${running ? ' is-running' : ''}${compact ? ' compact' : ''}`}>
      {suggestions.length > 0 && (
        <div className="slash-menu" role="listbox" aria-label="Slash commands">
          {suggestions.map((command, index) => (
            <button
              key={command.name}
              type="button"
              role="option"
              aria-selected={index === slashIndex}
              className={`slash-item${index === slashIndex ? ' active' : ''}`}
              onMouseEnter={() => setSlashIndex(index)}
              onClick={() => {
                setText(`${command.name.startsWith('/') ? command.name : `/${command.name}`} `)
                input.current?.focus()
              }}
            >
              <span className="slash-name">{command.name.startsWith('/') ? command.name : `/${command.name}`}</span>
              <span className="slash-desc">{command.description}</span>
            </button>
          ))}
        </div>
      )}
      <div className="composer-box" onClick={() => input.current?.focus()}>
        <textarea
          ref={input}
          value={text}
          rows={1}
          placeholder={placeholder}
          aria-label="Message"
          onChange={event => setText(event.target.value)}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return
            if (suggestions.length) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                const delta = event.key === 'ArrowDown' ? 1 : -1
                setSlashIndex(index => (index + delta + suggestions.length) % suggestions.length)
                return
              }
              if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
                const pick = suggestions[slashIndex]
                const name = pick ? (pick.name.startsWith('/') ? pick.name : `/${pick.name}`) : undefined
                if (name && name !== text.trim()) {
                  event.preventDefault()
                  setText(`${name} `)
                  return
                }
              }
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void submit()
            }
            if (event.key === 'Escape' && showStop) {
              event.preventDefault()
              onStop?.()
            }
          }}
        />
        <div className="composer-toolbar" onClick={event => event.stopPropagation()}>
          <div className="composer-controls">{toolbar}</div>
          {showStop
            ? (
              <button type="button" className="send-button stop" onClick={onStop} aria-label="Stop" title="Stop (Esc)">
                <Square size={13} fill="currentColor" />
              </button>
            )
            : (
              <button
                type="button"
                className="send-button"
                onClick={() => void submit()}
                disabled={!text.trim() || Boolean(disabledReason)}
                aria-label="Send"
                title="Send (Enter)"
              >
                <ArrowUp size={17} strokeWidth={2.4} />
              </button>
            )}
        </div>
      </div>
      {!compact && (
        <div className="composer-footer">
          {disabledReason
            ? <span className="composer-warning"><Sparkles size={13} />{disabledReason}</span>
            : footer ?? <span><kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line{commands.length ? <> · <kbd>/</kbd> for commands</> : null}</span>}
        </div>
      )}
    </div>
  )
}

/** Session composer: the prompt box plus the per-session run settings. */
export function Composer({
  settings,
  onSettingsChange,
  models,
  defaultModelId,
  commands,
  running,
  locked,
  disabledReason,
  onSubmit,
  onStop,
  placeholder,
  autoFocusKey,
}: {
  settings: RunSettings
  onSettingsChange: (patch: Partial<RunSettings>) => void
  models: ModelOption[]
  defaultModelId?: string | undefined
  commands: SlashCommand[]
  running: boolean
  /** Settings can't change while a run is active. */
  locked: boolean
  disabledReason?: ReactNode
  onSubmit: (text: string) => Promise<boolean> | boolean
  onStop: () => void
  placeholder: string
  autoFocusKey?: string | undefined
}) {
  const activeModel = models.find(model => model.id === (settings.model || defaultModelId))
  const efforts: Effort[] = activeModel?.reasoningEfforts ?? []
  return (
    <PromptBox
      commands={commands}
      running={running}
      disabledReason={disabledReason}
      onSubmit={onSubmit}
      onStop={onStop}
      placeholder={placeholder}
      autoFocusKey={autoFocusKey}
      toolbar={
        <>
          <Choice label="Agent" value={settings.agentType} options={AGENT_OPTIONS} onChange={agentType => onSettingsChange({ agentType })} disabled={locked} />
          <Choice label="Mode" value={settings.mode} options={MODE_OPTIONS} onChange={mode => onSettingsChange({ mode })} disabled={locked} />
          <Choice label="Permissions" value={settings.permission} options={PERMISSION_OPTIONS} onChange={permission => onSettingsChange({ permission })} disabled={locked} />
          <Choice label="Model" value={settings.model ?? ''} options={modelOptions(models, defaultModelId)} onChange={model => onSettingsChange({ model: model || undefined })} disabled={locked || models.length === 0} />
          {efforts.length > 0 && (
            <Choice
              label="Reasoning effort"
              value={settings.reasoningEffort}
              icon={<Gauge size={14} />}
              options={(['default', ...efforts] as SessionEffort[]).map(value => ({ value, label: EFFORT_LABEL[value], icon: <Gauge size={14} /> }))}
              onChange={reasoningEffort => onSettingsChange({ reasoningEffort })}
              disabled={locked}
            />
          )}
        </>
      }
    />
  )
}
