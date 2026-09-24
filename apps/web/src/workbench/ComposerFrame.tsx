import type { ReactNode } from 'react'
import { Button, Select } from '@radix-ui/themes'
import { FolderOpen, Shield } from 'lucide-react'
import { workspaceName } from './workspace'

interface Props {
  children: ReactNode
  accessory?: ReactNode
  workspace: string
  model?: string
  models: Array<{ id: string; reasoningEfforts: Array<'low' | 'medium' | 'high'> }>
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
  const models = selectedModel || !props.model
    ? props.models : [{ id: props.model, reasoningEfforts: [] }, ...props.models]
  const effort = props.reasoningEffort !== 'default'
    && selectedModel?.reasoningEfforts.includes(props.reasoningEffort)
    ? props.reasoningEffort : 'default'
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
        <Select.Root value={props.model || ''} disabled={props.disabled || !props.model}
          onValueChange={value => { void props.onModel(value) }}>
          <Select.Trigger variant="ghost" aria-label="Conversation model" />
          <Select.Content>
            {models.map(item => <Select.Item key={item.id} value={item.id}>{item.id}</Select.Item>)}
          </Select.Content>
        </Select.Root>
        <Select.Root value={effort} disabled={props.disabled || !selectedModel?.reasoningEfforts.length}
          onValueChange={value => {
            if (value === 'default' || value === 'low' || value === 'medium' || value === 'high')
              void props.onReasoningEffort(value)
          }}>
          <Select.Trigger variant="ghost" aria-label="Thinking effort" />
          <Select.Content>
            <Select.Item value="default">Thinking: default</Select.Item>
            {selectedModel?.reasoningEfforts.map(effort =>
              <Select.Item key={effort} value={effort}>{`Thinking: ${effort}`}</Select.Item>)}
          </Select.Content>
        </Select.Root>
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
