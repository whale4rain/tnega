import { Box, Copy, Laptop, RefreshCw, Server, UserRound } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { confirmDialog } from '../lib/dialogs'
import { errorText, folderName, relativeTime } from '../lib/hooks'
import type { AccountInfo, AccountRole, AdminBox, AdminDevice, AdminOverview, InviteCode } from '../lib/types'
import { ChoiceField } from './ChoiceField'

export const ROLE_LABEL: Record<AccountRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' }

/** Which roles `role` may hand out (the server checks the same). */
function grantable(role: AccountRole): AccountRole[] {
  return role === 'owner' ? ['member', 'admin', 'owner'] : role === 'admin' ? ['member'] : []
}

/** Whether `me` may look after `role`'s devices (the server checks the same). */
function manages(me: AccountRole, role: AccountRole): boolean {
  return me === 'owner' || (me === 'admin' && role === 'member')
}

const BOX_STATE: Record<AdminBox['state'], string> = { running: 'Running', paused: 'Paused', cold: 'Stopped' }

/**
 * Settings → Server: the admin page of a tnega server, for owners and admins.
 * One quiet page: a summary, the people who can sign in, every device signed
 * in (and which daemons are connected now), and the boxes the server runs.
 */
export function ServerAdmin({ me }: { me: AccountInfo }) {
  const [overview, setOverview] = useState<AdminOverview>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const value = await api.adminOverview(signal)
      if (!signal?.aborted) { setOverview(value); setError(undefined) }
    } catch (reason) {
      if (!signal?.aborted) setError(errorText(reason))
    }
  }, [])

  useEffect(() => {
    const scope = new AbortController()
    void load(scope.signal)
    return () => scope.abort()
  }, [load])

  const act = async (id: string, work: () => Promise<unknown>) => {
    setBusy(id)
    setError(undefined)
    try {
      await work()
      await load()
    } catch (reason) { setError(errorText(reason)) }
    finally { setBusy(undefined) }
  }

  const people = new Map(overview?.people.map(person => [person.id, person]) ?? [])
  const nameOf = (accountId: string) => people.get(accountId)?.name ?? 'Someone removed'
  const roleOf = (accountId: string): AccountRole => people.get(accountId)?.role ?? 'member'
  const devices = overview?.devices.filter(device => !device.box) ?? []
  const connected = overview?.devices.filter(device => device.connected).length ?? 0
  const boxes = overview?.boxes
  const running = boxes?.list.filter(box => box.state === 'running').length ?? 0

  const signOut = async (device: AdminDevice) => {
    const confirmed = await confirmDialog({
      title: `Sign out ${device.name}?`,
      message: device.kind === 'daemon'
        ? `${nameOf(device.accountId)}'s daemon is disconnected and its token stops working. They pair it again to use it.`
        : `${nameOf(device.accountId)} is signed out on this device and signs in again to use it.`,
      confirmLabel: 'Sign out',
      danger: true,
    })
    if (confirmed) await act(device.id, () => api.revokeDevice(device.accountId, device.id))
  }

  const stopBox = async (box: AdminBox) => {
    const confirmed = await confirmDialog({
      title: `Stop ${nameOf(box.accountId)}'s box?`,
      message: 'Its processes end and the box is removed. The folder it worked in stays; the next run starts a fresh box.',
      confirmLabel: 'Stop box',
      danger: true,
    })
    if (confirmed) await act(box.id, () => api.stopBox(box.id))
  }

  return <div className="server-admin">
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    <div className="server-admin-head">
      <div className="effective-card">
        <div className="effective-row"><span className="muted">People</span><span>{overview ? overview.people.filter(person => !person.disabled).length : '…'}</span></div>
        <div className="effective-row"><span className="muted">Connected daemons</span><span>{overview ? connected : '…'}</span></div>
        <div className="effective-row"><span className="muted">Boxes</span><span>{overview ? boxes ? `${running} of ${boxes.maxRunning} running · ${boxes.provider}` : 'Off' : '…'}</span></div>
      </div>
      <button type="button" className="icon-button small" aria-label="Refresh" title="Refresh" disabled={busy !== undefined} onClick={() => void load()}>
        <RefreshCw size={14} aria-hidden />
      </button>
    </div>

    <People me={me} />

    <section className="people" aria-labelledby="devices-heading">
      <h4 id="devices-heading">Devices</h4>
      {overview && !devices.length && <p className="muted small">Nobody is signed in yet.</p>}
      {devices.length > 0 && <ul className="people-list" aria-label="Devices">
        {devices.map(device => <li key={device.id} className="people-row">
          {device.kind === 'daemon' ? <Server size={14} aria-hidden /> : <Laptop size={14} aria-hidden />}
          <span className="people-name">{device.name}</span>
          <span className="server-admin-owner">{nameOf(device.accountId)}</span>
          <span className="muted small">{device.connected
            ? 'Connected'
            : device.lastSeen ? `Seen ${relativeTime(Date.parse(device.lastSeen))}` : device.kind === 'daemon' ? 'Daemon' : 'App'}</span>
          {(device.accountId === me.id || manages(me.role, roleOf(device.accountId))) && <button
            type="button"
            className="button ghost small"
            aria-label={`Sign out ${device.name} of ${nameOf(device.accountId)}`}
            disabled={busy !== undefined}
            onClick={() => void signOut(device)}
          >Sign out</button>}
        </li>)}
      </ul>}
    </section>

    {boxes && <section className="people" aria-labelledby="boxes-heading">
      <h4 id="boxes-heading">Boxes</h4>
      {!boxes.list.length && <p className="muted small">No boxes yet. A box starts the first time someone runs an agent here.</p>}
      {boxes.list.length > 0 && <ul className="people-list" aria-label="Boxes">
        {boxes.list.map(box => <li key={box.id} className="people-row">
          <Box size={14} aria-hidden />
          <span className="people-name">{nameOf(box.accountId)}</span>
          <span className="server-admin-owner" title={box.workspace}>{folderName(box.workspace)}</span>
          <span className={box.state === 'running' ? 'pill' : 'muted small'}>{BOX_STATE[box.state]}</span>
          <span className="muted small">{relativeTime(Date.parse(box.lastUsed))}</span>
          {box.state === 'running' && <button
            type="button"
            className="button ghost small"
            aria-label={`Pause ${nameOf(box.accountId)}'s box`}
            disabled={busy !== undefined}
            onClick={() => void act(box.id, () => api.pauseBox(box.id))}
          >Pause</button>}
          <button
            type="button"
            className="button ghost small"
            aria-label={`Stop ${nameOf(box.accountId)}'s box`}
            disabled={busy !== undefined}
            onClick={() => void stopBox(box)}
          >Stop</button>
        </li>)}
      </ul>}
    </section>}
  </div>
}

/** The people who can sign in: roles, disabling, and invite links. */
export function People({ me }: { me: AccountInfo }) {
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
