import { MonitorX, X } from 'lucide-react'
import { useComputerHint } from '../lib/computer-hint'

/**
 * One dismissible line above the chat when computer use cannot work because its
 * driver is missing. Without it the symptom is silence: the tools are absent
 * when the switch is off, and a call fails with an install command that only the
 * model sees, so the person at the window is never told what to install.
 */
export function ComputerHint({ enabled }: { enabled: boolean }) {
  const { setup, visible, dismiss } = useComputerHint()
  if (!visible || !setup) return null
  return (
    <div className="notice notice-info mxc-hint" role="status">
      <MonitorX size={14} />
      <span>
        {enabled
          ? 'Computer use is on, but cua-driver is not installed, so those tools cannot work.'
          : 'The computer use tools need cua-driver, which is not installed.'}
        {' '}Install it with <code>{setup.install.command}</code>, then restart tnega
        {enabled ? '.' : ', and turn Computer use on under Settings.'}
        {' '}<a href={setup.install.url} target="_blank" rel="noreferrer noopener">About cua-driver</a>
      </span>
      <button type="button" className="icon-button tiny" aria-label="Dismiss computer use hint" onClick={dismiss}><X size={14} /></button>
    </div>
  )
}
