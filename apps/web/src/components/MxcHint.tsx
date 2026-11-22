import { ShieldCheck } from 'lucide-react'
import { useMxcHint } from '../lib/sandbox-hint'
import { InstallNotice } from './InstallNotice'

/**
 * One dismissible notice above the chat on Windows 24H2+ when Microsoft MXC
 * could sandbox commands but is not installed. tnega keeps using its own
 * Windows sandbox until it is.
 */
export function MxcHint() {
  const { setup, visible, dismiss } = useMxcHint()
  if (!visible || !setup) return null
  return (
    <InstallNotice
      icon={<ShieldCheck size={16} />}
      command={setup.install.command}
      after="Run it, then restart tnega."
      about={{ url: setup.install.url, label: 'About MXC' }}
      dismissLabel="Dismiss MXC hint"
      onDismiss={dismiss}
    >
      This Windows can run the agent's commands in Microsoft MXC, a stronger sandbox.
    </InstallNotice>
  )
}
