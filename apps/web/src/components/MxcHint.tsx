import { ShieldCheck, X } from 'lucide-react'
import { useMxcHint } from '../lib/sandbox-hint'

/**
 * One dismissible line above the chat on Windows 24H2+ when Microsoft MXC
 * could sandbox commands but is not installed. tnega keeps using its own
 * Windows sandbox until it is.
 */
export function MxcHint() {
  const { setup, visible, dismiss } = useMxcHint()
  if (!visible || !setup) return null
  return (
    <div className="notice notice-info mxc-hint" role="status">
      <ShieldCheck size={14} />
      <span>
        This Windows can run the agent's commands in Microsoft MXC, a stronger sandbox.
        {' '}Install it with <code>{setup.install.command}</code>, then restart tnega.
        {' '}<a href={setup.install.url} target="_blank" rel="noreferrer noopener">About MXC</a>
      </span>
      <button type="button" className="icon-button tiny" aria-label="Dismiss MXC hint" onClick={dismiss}><X size={14} /></button>
    </div>
  )
}
