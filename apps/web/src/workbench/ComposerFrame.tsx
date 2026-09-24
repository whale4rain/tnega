import type { ReactNode } from 'react'
import { Button, Select } from '@radix-ui/themes'
import { FolderOpen, Shield } from 'lucide-react'
import { workspaceName } from './workspace'

interface Props {
  children: ReactNode
  accessory?: ReactNode
  workspace: string
  model?: string
  apiKeySet: boolean
  onSettings: () => void
  permission: 'read-only' | 'workspace-write' | 'bypass'
  onPermission: (value: 'read-only' | 'workspace-write' | 'bypass') => void
  disabled: boolean
  mode?: 'auto' | 'plan' | 'goal'
  onMode: (value: 'auto' | 'plan' | 'goal') => Promise<void>
}
export function ComposerFrame(props: Props) {
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
        <Button
          className="model-button"
          size="1"
          color="gray"
          variant="ghost"
          onClick={props.onSettings}
        >
          {props.model || 'Configure model'}
        </Button>
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
