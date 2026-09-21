import type { ReactNode } from 'react'
import { Button, DropdownMenu, Select } from '@radix-ui/themes'
import { ChevronDown, FolderOpen, Shield } from 'lucide-react'
import { workspaceName } from './workspace'

interface Props {
  children: ReactNode
  accessory?: ReactNode
  workspace: string
  model?: string
  apiKeySet: boolean
  onSettings: () => void
  allowNetwork: boolean
  allowShell: boolean
  onNetwork: (value: boolean) => void
  onShell: (value: boolean) => void
  disabled: boolean
  mode?: 'auto' | 'plan' | 'execute'
  onMode: (value: 'auto' | 'plan' | 'execute') => Promise<void>
}
export function ComposerFrame(props: Props) {
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
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            <Button
              size="1"
              variant="ghost"
              color="gray"
              disabled={props.disabled}
            >
              <Shield size={14} />
              {props.allowShell || props.allowNetwork
                ? 'Custom permissions'
                : 'Restricted'}
              <ChevronDown size={12} />
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content>
            <DropdownMenu.Label>Tool access for this run</DropdownMenu.Label>
            <DropdownMenu.CheckboxItem
              checked={props.allowNetwork}
              onCheckedChange={props.onNetwork}
            >
              Network access
            </DropdownMenu.CheckboxItem>
            <DropdownMenu.CheckboxItem
              checked={props.allowShell}
              onCheckedChange={props.onShell}
            >
              Shell commands
            </DropdownMenu.CheckboxItem>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
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
              if (value === 'auto' || value === 'plan' || value === 'execute')
                void props.onMode(value)
            }}
          >
            <Select.Trigger variant="ghost" aria-label="Session mode" />
            <Select.Content>
              <Select.Item value="auto">Auto</Select.Item>
              <Select.Item value="plan">Plan</Select.Item>
              <Select.Item value="execute">Execute</Select.Item>
            </Select.Content>
          </Select.Root>
        )}
      </div>
    </section>
  )
}
