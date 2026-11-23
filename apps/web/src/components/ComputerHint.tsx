import { MonitorX } from 'lucide-react'
import { useComputerHint } from '../lib/computer-hint'
import { InstallNotice } from './InstallNotice'

/**
 * One dismissible notice above the chat when computer use cannot work because its
 * driver is missing. Without it the symptom is silence: the tools are absent
 * when the switch is off, and a call fails with an install command that only the
 * model sees, so the person at the window is never told what to install.
 */
export function ComputerHint({ enabled }: { enabled: boolean }) {
  const { setup, visible, dismiss } = useComputerHint()
  if (!visible || !setup) return null
  return (
    <InstallNotice
      icon={<MonitorX size={16} />}
      command={setup.install.command}
      after={enabled ? 'Run it, then restart tnega.' : 'Run it, then restart tnega, and turn Computer use on under Settings.'}
      about={{ url: setup.install.url, label: 'About cua-driver' }}
      dismissLabel="Dismiss computer use hint"
      onDismiss={dismiss}
    >
      {enabled
        ? 'Computer use is on, but cua-driver is not installed, so those tools cannot work.'
        : 'The computer use tools need cua-driver, which is not installed.'}
    </InstallNotice>
  )
}
