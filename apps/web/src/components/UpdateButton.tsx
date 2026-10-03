import { ArrowDownToLine, RotateCw } from 'lucide-react'
import { useState } from 'react'
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
  const [channelError, setChannelError] = useState<string>()
  const [savingChannel, setSavingChannel] = useState(false)
  if (!updates) return null
  const { state } = updates
  const busy = state.status === 'checking' || state.status === 'downloading'
  const changeChannel = async (value: string) => {
    if ((value !== 'stable' && value !== 'preview') || !updates.setChannel) return
    setSavingChannel(true)
    setChannelError(undefined)
    try { await updates.setChannel(value) }
    catch { setChannelError('Could not save the update channel. Please try again.') }
    finally { setSavingChannel(false) }
  }
  return (
    <div className="update-settings">
      <div>
        <div className="field-label">Tnega {state.version}</div>
        <p className="muted small">{describeUpdate(state)}</p>
        {updates.setChannel && state.status !== 'unsupported' && (
          <label className="field update-channel">
            <span className="field-label">Update channel</span>
            <select aria-label="Update channel" value={state.channel ?? 'stable'} disabled={busy || savingChannel} onChange={event => void changeChannel(event.target.value)}>
              <option value="stable">Stable</option>
              <option value="preview">Preview (pre)</option>
            </select>
            <span className="muted small">Preview includes early releases. Stable waits for the next stable release; it does not downgrade.</span>
          </label>
        )}
        {channelError && <p className="notice-error small" role="alert">{channelError}</p>}
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
