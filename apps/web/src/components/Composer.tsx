import { Briefcase, Code2, Gauge, MessageSquare, ShieldAlert, ShieldCheck, ShieldHalf, Sparkles, Target, ListChecks, Zap, Cpu } from 'lucide-react'
import type { ReactNode } from 'react'
import type { CommandSpec } from '../lib/completion'
import type { AgentType, ApprovalMode, ImageAttachment, ModelOption, Permission, SessionEffort, SessionMode } from '../lib/types'
import { Choice, SectionChoice, choiceSection, type ChoiceOption } from './Menu'
import { PromptBox, type ArgumentSuggestion } from './PromptBox'

export { PromptBox }

export interface RunSettings {
  agentType: AgentType
  mode: SessionMode
  permission: Permission
  approvalMode?: ApprovalMode
  model?: string | undefined
  reasoningEffort: SessionEffort
}

export const AGENT_OPTIONS: ReadonlyArray<ChoiceOption<AgentType>> = [
  { value: 'coding', label: 'Coding', description: 'Workspace-aware engineer with skills, plans and slash commands', icon: <Code2 size={14} /> },
  { value: 'work', label: 'Work', description: 'Turns your files into spreadsheets, documents and slide decks', icon: <Briefcase size={14} /> },
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

export const APPROVAL_OPTIONS: ReadonlyArray<ChoiceOption<ApprovalMode>> = [
  { value: 'manual', label: 'Ask me', description: 'Review permission requests yourself', icon: <ShieldCheck size={14} /> },
  { value: 'auto', label: 'Auto review', description: 'Let the reviewer approve permitted actions; ask when uncertain', icon: <Sparkles size={14} /> },
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

/** Session composer: the prompt box plus the per-session run settings. */
export function Composer({
  settings,
  onSettingsChange,
  models,
  defaultModelId,
  commands,
  completeArgument,
  searchFiles,
  running,
  allowWhileRunning,
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
  commands: readonly CommandSpec[]
  completeArgument?: (command: string, query: string) => Promise<ArgumentSuggestion[]>
  searchFiles?: (query: string) => Promise<string[]>
  running: boolean
  allowWhileRunning?: boolean
  /** Settings can't change while a run is active. */
  locked: boolean
  disabledReason?: ReactNode
  onSubmit: (text: string, images: ImageAttachment[]) => Promise<boolean> | boolean
  onStop: () => void
  placeholder: string
  autoFocusKey?: string | undefined
}) {
  const active = models.find(model => model.id === (settings.model || defaultModelId))
  return (
    <PromptBox
      acceptImages
      imageNotice={active && !active.vision
        ? `${active.name || active.id} can't see images; they will be described as omitted.`
        : undefined}
      commands={commands}
      completeArgument={completeArgument}
      searchFiles={searchFiles}
      running={running}
      allowWhileRunning={allowWhileRunning}
      disabledReason={disabledReason}
      onSubmit={onSubmit}
      onStop={onStop}
      placeholder={placeholder}
      autoFocusKey={autoFocusKey}
      toolbar={
        <>
          <Choice label="Mode" value={settings.mode} options={MODE_OPTIONS} onChange={mode => onSettingsChange({ mode })} disabled={locked} />
          <ModelChoice settings={settings} onSettingsChange={onSettingsChange} models={models} defaultModelId={defaultModelId} disabled={locked} />
        </>
      }
    />
  )
}

const EFFORT_SHORT: Record<SessionEffort, string> = { default: '', low: 'Low', medium: 'Medium', high: 'High' }

/** Model and reasoning effort in one chip: the effort only applies to the chosen model. */
function ModelChoice({
  settings,
  onSettingsChange,
  models,
  defaultModelId,
  disabled,
}: {
  settings: RunSettings
  onSettingsChange: (patch: Partial<RunSettings>) => void
  models: ModelOption[]
  defaultModelId?: string | undefined
  disabled: boolean
}) {
  const options = modelOptions(models, defaultModelId)
  const active = models.find(model => model.id === (settings.model || defaultModelId))
  const efforts: SessionEffort[] = active?.reasoningEfforts.length ? ['default', ...active.reasoningEfforts] : []
  const current = options.find(option => option.value === (settings.model ?? '')) ?? options[0]
  const effort = efforts.length && settings.reasoningEffort !== 'default' ? ` · ${EFFORT_SHORT[settings.reasoningEffort]}` : ''
  const sections = [
    choiceSection('model', 'Model', options, settings.model ?? '', model => onSettingsChange({ model: model || undefined })),
    ...(efforts.length
      ? [choiceSection(
        'effort',
        'Reasoning effort',
        efforts.map(value => ({ value, label: EFFORT_LABEL[value], icon: <Gauge size={14} /> })),
        settings.reasoningEffort,
        reasoningEffort => onSettingsChange({ reasoningEffort }),
      )]
      : []),
  ]
  return (
    <SectionChoice
      label="Model"
      summary={`${current?.label ?? 'Default model'}${effort}`}
      icon={<Cpu size={14} />}
      sections={sections}
      disabled={disabled || models.length === 0}
    />
  )
}

/**
 * Session-level settings that rarely change during a conversation: who the agent is and
 * what it may do. They live in the conversation header, out of the composer's way.
 */
export function SessionControls({
  settings,
  onSettingsChange,
  locked,
}: {
  settings: RunSettings
  onSettingsChange: (patch: Partial<RunSettings>) => void
  locked: boolean
}) {
  const permission = PERMISSION_OPTIONS.find(option => option.value === settings.permission) ?? PERMISSION_OPTIONS[0]
  const approval = settings.approvalMode ?? 'manual'
  return (
    <div className="session-controls">
      <Choice
        label="Agent"
        value={settings.agentType}
        options={AGENT_OPTIONS}
        onChange={agentType => onSettingsChange({ agentType })}
        disabled={locked}
        side="bottom"
        align="end"
      />
      <SectionChoice
        label="Access"
        summary={`${permission?.label ?? ''}${approval === 'auto' ? ' · Auto review' : ''}`}
        icon={permission?.icon}
        {...(permission?.tone ? { tone: permission.tone } : {})}
        sections={[
          choiceSection('permission', 'Permissions', PERMISSION_OPTIONS, settings.permission, value => onSettingsChange({ permission: value })),
          choiceSection('approval', 'Approvals', APPROVAL_OPTIONS, approval, value => onSettingsChange({ approvalMode: value })),
        ]}
        disabled={locked}
        side="bottom"
        align="end"
      />
    </div>
  )
}
