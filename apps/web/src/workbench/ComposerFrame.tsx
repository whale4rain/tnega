import { useEffect, useState, type ReactNode } from 'react'
import { Button, Popover, Select, Slider } from '@radix-ui/themes'
import { ChevronLeft, ChevronRight, FolderOpen, Shield, SlidersHorizontal } from 'lucide-react'
import { workspaceName } from './workspace'

interface Props {
  children: ReactNode
  accessory?: ReactNode
  workspace: string
  model?: string
  models: Array<{ id: string; name: string; reasoningEfforts: Array<'low' | 'medium' | 'high'> }>
  reasoningEffort: 'default' | 'low' | 'medium' | 'high'
  onModel: (model: string) => Promise<void>
  onReasoningEffort: (effort: 'default' | 'low' | 'medium' | 'high') => Promise<void>
  apiKeySet: boolean
  onSettings: () => void
  permission: 'read-only' | 'workspace-write' | 'bypass'
  onPermission: (value: 'read-only' | 'workspace-write' | 'bypass') => void
  disabled: boolean
  mode?: 'auto' | 'plan' | 'goal'
  onMode: (value: 'auto' | 'plan' | 'goal') => Promise<void>
}
export function ComposerFrame(props: Props) {
  const selectedModel = props.models.find(item => item.id === props.model)
  const models = props.models
  const selectedIndex = Math.max(0, models.findIndex(item => item.id === props.model))
  const [previewIndex, setPreviewIndex] = useState(selectedIndex)
  const [previewEffortIndex, setPreviewEffortIndex] = useState(0)
  useEffect(() => setPreviewIndex(selectedIndex), [selectedIndex, models.length])
  const effort = props.reasoningEffort !== 'default'
    && selectedModel?.reasoningEfforts.includes(props.reasoningEffort)
    ? props.reasoningEffort : 'default'
  const previewModel = models[Math.min(previewIndex, models.length - 1)]
  const effortChoices: Array<'default' | 'low' | 'medium' | 'high'> = [
    'default', ...(previewModel?.reasoningEfforts ?? []),
  ]
  const selectedEffortIndex = Math.max(0, effortChoices.indexOf(effort))
  useEffect(() => setPreviewEffortIndex(selectedEffortIndex), [selectedEffortIndex, previewModel?.id, effortChoices.length])
  const previewEffort = effortChoices[Math.min(previewEffortIndex, effortChoices.length - 1)] ?? 'default'
  const selectModel = (index: number) => {
    const next = models[index]
    if (!next) return
    setPreviewIndex(index)
    if (next.id !== props.model) void props.onModel(next.id)
  }
  const permissionHint = {
    'read-only': 'Read workspace · public web search',
    'workspace-write': 'Write workspace · shell access',
    bypass: 'Full access · no approval prompts',
  }[props.permission]
  return (
    <section className="composer-dock" aria-label="Message composer">
      {props.accessory}
      {!props.apiKeySet && (
        <div className="config-notice">
          Connect a model to start a conversation.
          <Button size="1" variant="ghost" onClick={props.onSettings}>
            Open settings
          </Button>
        </div>
      )}
      <div className="composer-context flex items-center gap-2">
        <FolderOpen size={14} />
        <span className="truncate" title={props.workspace}>
          {workspaceName(props.workspace)}
        </span>
        <span className="ml-auto text-xs">Local workspace</span>
      </div>
      <div className="composer">{props.children}</div>
      <div className="composer-toolbar flex items-center gap-3">
        <Shield size={14} />
        <Select.Root
          value={props.permission}
          disabled={props.disabled}
          onValueChange={value => {
            if (value === 'read-only' || value === 'workspace-write' || value === 'bypass')
              props.onPermission(value)
          }}
        >
          <Select.Trigger variant="ghost" aria-label="Tool permissions" title={permissionHint} />
          <Select.Content>
            <Select.Item value="read-only">Read only</Select.Item>
            <Select.Item value="workspace-write">Workspace write</Select.Item>
            <Select.Item value="bypass">Bypass</Select.Item>
          </Select.Content>
        </Select.Root>
        <span className="permission-hint" title={permissionHint}>{permissionHint}</span>
        <span className="composer-shortcut">
          Enter to send · Shift + Enter for newline
        </span>
        <Popover.Root>
          <Popover.Trigger>
            <Button className="model-control-trigger" size="1" color="gray" variant="ghost"
              disabled={props.disabled || !props.model} aria-label="Model and thinking settings">
              <SlidersHorizontal size={14} />
              <span className="truncate">{selectedModel?.name ?? props.model ?? 'Select model'}</span>
              <span className="model-effort-label">{effort}</span>
            </Button>
          </Popover.Trigger>
          <Popover.Content className="model-slider-panel" align="end" side="top" sideOffset={12}>
            <div className="model-slider-heading">
              <span>Model</span>
              <span>{models.length ? `${previewIndex + 1} / ${models.length}` : '—'}</span>
            </div>
            <div className="model-slider-current">
              <button type="button" aria-label="Previous model" disabled={props.disabled || previewIndex <= 0}
                onClick={() => selectModel(previewIndex - 1)}><ChevronLeft size={18} /></button>
              <strong title={previewModel?.id}>{previewModel?.name ?? 'No model'}</strong>
              <button type="button" aria-label="Next model" disabled={props.disabled || previewIndex >= models.length - 1}
                onClick={() => selectModel(previewIndex + 1)}><ChevronRight size={18} /></button>
            </div>
            <Slider aria-label="Choose model" min={0} max={Math.max(1, models.length - 1)} step={1}
              value={[previewIndex]} disabled={props.disabled || models.length < 2}
              onValueChange={values => setPreviewIndex(values[0] ?? 0)}
              onValueCommit={values => selectModel(values[0] ?? 0)} />
            <div className="model-slider-heading thinking-heading">
              <span>Thinking</span><span>{previewEffort}</span>
            </div>
            <Slider aria-label="Choose thinking effort" min={0} max={Math.max(1, effortChoices.length - 1)} step={1}
              value={[previewEffortIndex]}
              disabled={props.disabled || previewModel?.id !== props.model || effortChoices.length < 2}
              onValueChange={values => setPreviewEffortIndex(values[0] ?? 0)}
              onValueCommit={values => {
                const next = effortChoices[values[0] ?? 0]
                if (next && next !== effort) void props.onReasoningEffort(next)
              }} />
            <div className="model-slider-ticks">
              {effortChoices.map(choice => <span key={choice}>{choice}</span>)}
            </div>
            {effortChoices.length < 2 && <p className="model-slider-note">This model uses its own thinking default.</p>}
          </Popover.Content>
        </Popover.Root>
        {props.mode && (
          <Select.Root
            value={props.mode}
            disabled={props.disabled}
            onValueChange={(value) => {
              if (value === 'auto' || value === 'plan' || value === 'goal')
                void props.onMode(value)
            }}
          >
            <Select.Trigger variant="ghost" aria-label="Session mode" />
            <Select.Content>
              <Select.Item value="auto">Auto</Select.Item>
              <Select.Item value="plan">Plan</Select.Item>
              <Select.Item value="goal">Goal</Select.Item>
            </Select.Content>
          </Select.Root>
        )}
      </div>
    </section>
  )
}
