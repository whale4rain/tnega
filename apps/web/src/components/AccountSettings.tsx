import { useState, type FormEvent } from 'react'
import { api } from '../lib/api'
import { errorText } from '../lib/hooks'
import type { AuthSession } from '../lib/types'
import { ROLE_LABEL } from './ServerAdmin'
import { SettingsCard } from './SettingsCard'

/**
 * The signed-in person on a tnega server: who they are, signing out and
 * their password. The people, devices and boxes are under Server.
 */
export function AccountSettings({ session, onSignedOut }: { session: AuthSession; onSignedOut: () => void }) {
  const { account } = session
  const [error, setError] = useState<string>()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [passwordNote, setPasswordNote] = useState<string>()

  const signOut = async () => {
    setError(undefined)
    try {
      await api.signOut()
      onSignedOut()
    } catch (reason) { setError(errorText(reason)) }
  }

  const changePassword = async (event: FormEvent) => {
    event.preventDefault()
    setError(undefined)
    setPasswordNote(undefined)
    try {
      await api.changePassword(current, next)
      setCurrent('')
      setNext('')
      setPasswordNote('Password changed. Your other devices were signed out.')
    } catch (reason) { setError(errorText(reason)) }
  }

  return <div className="account-settings">
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    <SettingsCard
      title={account.name}
      description={`${account.login} · ${ROLE_LABEL[account.role]}`}
      control={<button type="button" className="button secondary small" onClick={() => void signOut()}>Sign out</button>}
    >
      {session.workspace && <div className="effective-card">
        <div className="effective-row"><span>Your folder</span><code>{session.workspace}</code></div>
      </div>}
    </SettingsCard>

    <SettingsCard title="Password" description={passwordNote ?? 'At least 10 characters. Changing it signs your other devices out.'}>
      <form className="form-grid" onSubmit={event => void changePassword(event)} aria-label="Change password">
        <label className="field">
          <span className="field-label">Current password</span>
          <input type="password" value={current} onChange={event => setCurrent(event.target.value)} autoComplete="current-password" required />
        </label>
        <label className="field">
          <span className="field-label">New password</span>
          <input type="password" value={next} onChange={event => setNext(event.target.value)} autoComplete="new-password" minLength={10} required />
        </label>
        <div className="field span-2">
          <div><button type="submit" className="button secondary small" disabled={!current || !next}>Change password</button></div>
        </div>
      </form>
    </SettingsCard>
  </div>
}
