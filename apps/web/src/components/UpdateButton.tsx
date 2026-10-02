import { ArrowDownToLine, RotateCw } from 'lucide-react'
import { describeUpdate, type DesktopUpdates } from '../lib/desktop-updates'

/**
 * Sidebar footer pill: quiet while a new release downloads in the background,
 * then a one-click restart into it. Nothing shows while the app is current.
 */
export function UpdateButton({ updates }: { updates: DesktopUpdates | undefined }) {
  const state = updates?.state
  if (!updates || !state) return null
  if (state.status === 'downloading') {
    return (
      <span className="update-pill pending" role="status" title={describeUpdate(state)}>
        <ArrowDownToLine size={13} />
        <span>{state.percent}%</span>
      </span>
    )
  }
  if (state.status !== 'ready') return null
  return (
    <button type="button" className="update-pill ready" onClick={updates.install} title={`Restart into Tnega ${state.next}`}>
      <RotateCw size={13} />
      <span>Update</span>
    </button>
  )
}

/** Settings row: the running version, the update status and the matching action. */
export function UpdateSettings({ updates }: { updates: DesktopUpdates | undefined }) {
  if (!updates) return null
  const { state } = updates
  const busy = state.status === 'checking' || state.status === 'downloading'
  return (
    <div className="update-settings">
      <div>
        <div className="field-label">Tnega {state.version}</div>
        <p className="muted small">{describeUpdate(state)}</p>
      </div>
      {state.status === 'ready'
        ? <button type="button" className="button primary small" onClick={updates.install}>Restart to update</button>
        : state.status !== 'unsupported' && (
          <button type="button" className="button ghost small" onClick={updates.check} disabled={busy}>
            {busy ? 'Checking…' : 'Check for updates'}
          </button>
        )}
    </div>
  )
}
