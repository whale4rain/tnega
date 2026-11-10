import { Copy, UserRound } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { api } from '../lib/api'
import { runsServer } from '../lib/account'
import { confirmDialog } from '../lib/dialogs'
import { errorText } from '../lib/hooks'
import type { AccountInfo, AccountRole, AuthSession, InviteCode } from '../lib/types'
import { ChoiceField } from './ChoiceField'

const ROLE_LABEL: Record<AccountRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' }

/** Which roles `role` may hand out (the server checks the same). */
function grantable(role: AccountRole): AccountRole[] {
  return role === 'owner' ? ['member', 'admin', 'owner'] : role === 'admin' ? ['member'] : []
}

/**
 * The signed-in person on a tnega server: who they are, signing out, their
 * password, and, for owners and admins, the people who can sign in.
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
    <div className="effective-card">
      <div className="effective-row"><span className="muted">Signed in as</span><span>{account.name} <span className="muted">({account.login})</span></span></div>
      <div className="effective-row"><span className="muted">Role</span><span>{ROLE_LABEL[account.role]}</span></div>
      {session.workspace && <div className="effective-row"><span className="muted">Your folder</span><code>{session.workspace}</code></div>}
    </div>
    <div>
      <button type="button" className="button secondary small" onClick={() => void signOut()}>Sign out</button>
    </div>

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
        <span className="muted small">{passwordNote ?? 'At least 10 characters. Changing it signs your other devices out.'}</span>
        <div><button type="submit" className="button secondary small" disabled={!current || !next}>Change password</button></div>
      </div>
    </form>

    {runsServer(session) && <People me={account} />}
  </div>
}

function People({ me }: { me: AccountInfo }) {
  const [people, setPeople] = useState<AccountInfo[]>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const roles = grantable(me.role)
  const [inviteRole, setInviteRole] = useState<AccountRole>('member')
  const [invite, setInvite] = useState<InviteCode>()
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const scope = new AbortController()
    api.people(scope.signal).then(
      value => { if (!scope.signal.aborted) setPeople(value.users) },
      reason => { if (!scope.signal.aborted) setError(errorText(reason)) },
    )
    return () => scope.abort()
  }, [])

  const update = async (person: AccountInfo, patch: { role?: AccountRole; disabled?: boolean }) => {
    if (patch.disabled) {
      const confirmed = await confirmDialog({
        title: `Disable ${person.name}?`,
        message: 'They are signed out everywhere and cannot sign in until you enable them again. Their sessions stay.',
        confirmLabel: 'Disable',
        danger: true,
      })
      if (!confirmed) return
    }
    setBusy(person.id)
    setError(undefined)
    try {
      const { user } = await api.updatePerson(person.id, patch)
      setPeople(list => list?.map(entry => entry.id === user.id ? user : entry))
    } catch (reason) { setError(errorText(reason)) }
    finally { setBusy(undefined) }
  }

  const createInvite = async () => {
    setError(undefined)
    setCopied(false)
    try { setInvite(await api.invitePerson(inviteRole)) }
    catch (reason) { setError(errorText(reason)) }
  }
  const link = invite ? `${location.origin}/?invite=${encodeURIComponent(invite.code)}` : ''

  // The other person's role is changed only where this person may change it.
  const editable = (person: AccountInfo) => person.id !== me.id && roles.includes(person.role)

  return <section className="people" aria-labelledby="people-heading">
    <h4 id="people-heading">People</h4>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {people && <ul className="people-list" aria-label="People">
      {people.map(person => <li key={person.id} className="people-row">
        <UserRound size={14} aria-hidden="true" />
        <span className="people-name">{person.name}</span>
        <span className="people-login">{person.login}</span>
        {editable(person)
          // A select, not radio buttons: one per row would crowd the list (tnega-design §8 allows it for dense rows).
          ? <select aria-label={`Role of ${person.name}`} value={person.role} disabled={busy !== undefined || person.disabled} onChange={event => {
            const role = event.target.value
            if (role === 'owner' || role === 'admin' || role === 'member') void update(person, { role })
          }}>
            {roles.map(role => <option key={role} value={role}>{ROLE_LABEL[role]}</option>)}
          </select>
          : <span className="muted small">{ROLE_LABEL[person.role]}{person.id === me.id ? ' · you' : ''}</span>}
        {person.disabled && <span className="pill pill-danger">Disabled</span>}
        {editable(person) && <button
          type="button"
          className="button ghost small"
          aria-label={`${person.disabled ? 'Enable' : 'Disable'} ${person.name}`}
          disabled={busy !== undefined}
          onClick={() => void update(person, { disabled: !person.disabled })}
        >{person.disabled ? 'Enable' : 'Disable'}</button>}
      </li>)}
    </ul>}

    {roles.length > 0 && <div className="form-grid">
      <ChoiceField
        id="invite-role"
        label="Invite someone as"
        value={inviteRole}
        options={roles.map(role => [role, ROLE_LABEL[role]] as const)}
        onChange={role => { setInviteRole(role); setInvite(undefined) }}
        hint="Members work only in their own folder and cannot change server settings. Admins run the server."
      />
      <div className="field span-2">
        <div><button type="button" className="button secondary small" onClick={() => void createInvite()}>Create invite link</button></div>
        {invite && <>
          <div className="people-invite">
            <input readOnly value={link} aria-label="Invite link" onFocus={event => event.target.select()} />
            <button type="button" className="icon-button small" aria-label="Copy invite link" onClick={() => {
              void navigator.clipboard.writeText(link).then(() => setCopied(true), () => undefined)
            }}><Copy size={14} aria-hidden /></button>
          </div>
          <span className="muted small">{copied ? 'Copied. ' : ''}Works once, until {new Date(invite.expiresAt).toLocaleString()}.</span>
        </>}
      </div>
    </div>}
  </section>
}
