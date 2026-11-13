// @vitest-environment jsdom
import { createElement } from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { api, ApiError } from '../lib/api'
import { AccountContext } from '../lib/account'
import type { AccountInfo, AdminOverview, AuthSession, ConfigSnapshot } from '../lib/types'
import { AccountSettings } from './AccountSettings'
import { People, ServerAdmin } from './ServerAdmin'
import { AuthGate } from './AuthGate'
import { SettingsDialog } from './SettingsDialog'

vi.mock('../lib/dialogs', () => ({ confirmDialog: vi.fn(async () => true) }))

afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); history.replaceState(null, '', '/') })

const person = (login: string, role: AccountInfo['role'], extra: Partial<AccountInfo> = {}): AccountInfo =>
  ({ id: `id-${login}`, login, name: login.charAt(0).toUpperCase() + login.slice(1), role, disabled: false, createdAt: '2026-11-10T00:00:00Z', ...extra })

const owner: AuthSession = { account: person('ocean', 'owner') }
const member: AuthSession = { account: person('mia', 'member'), workspace: '/srv/members/mia' }

it('shows the sign-in page on a server and the app once signed in', async () => {
  const session = vi.spyOn(api, 'authSession')
    .mockRejectedValueOnce(new ApiError(401, 'sign in to this tnega server'))
    .mockResolvedValueOnce(owner)
  const signIn = vi.spyOn(api, 'signIn').mockResolvedValue({ account: owner.account })
  const view = render(createElement(AuthGate, null, createElement('p', null, 'the app')))
  expect(await view.findByRole('heading', { name: 'Sign in to tnega' })).toBeTruthy()
  fireEvent.change(view.getByLabelText('Login'), { target: { value: 'ocean' } })
  fireEvent.change(view.getByLabelText('Password'), { target: { value: 'owner-password' } })
  fireEvent.click(view.getByRole('button', { name: 'Sign in' }))
  await waitFor(() => expect(signIn).toHaveBeenCalledWith('ocean', 'owner-password', expect.any(String)))
  expect(await view.findByText('the app')).toBeTruthy()
  expect(session).toHaveBeenCalledTimes(2)
})

it('goes straight to the app on a local host, which has no sign-in', async () => {
  vi.spyOn(api, 'authSession').mockRejectedValue(new ApiError(404, 'not found'))
  const view = render(createElement(AuthGate, null, createElement('p', null, 'the app')))
  expect(await view.findByText('the app')).toBeTruthy()
})

it('creates the account an invite link is for, and drops the code from the address', async () => {
  history.replaceState(null, '', '/?invite=ABCDE-FGHJK')
  vi.spyOn(api, 'authSession').mockRejectedValueOnce(new ApiError(401, 'sign in')).mockResolvedValueOnce(member)
  const accept = vi.spyOn(api, 'acceptInvite').mockResolvedValue({ account: member.account })
  const view = render(createElement(AuthGate, null, createElement('p', null, 'the app')))
  expect(await view.findByRole('heading', { name: 'Join this tnega server' })).toBeTruthy()
  fireEvent.change(view.getByLabelText('Login'), { target: { value: 'mia' } })
  fireEvent.change(view.getByLabelText('Password'), { target: { value: 'long enough pass' } })
  fireEvent.change(view.getByLabelText('Password again'), { target: { value: 'different pass!' } })
  fireEvent.click(view.getByRole('button', { name: 'Create account' }))
  expect(await view.findByText('The two passwords are different.')).toBeTruthy()
  expect(accept).not.toHaveBeenCalled()
  fireEvent.change(view.getByLabelText('Password again'), { target: { value: 'long enough pass' } })
  fireEvent.click(view.getByRole('button', { name: 'Create account' }))
  await waitFor(() => expect(accept).toHaveBeenCalledWith(expect.objectContaining({ code: 'ABCDE-FGHJK', login: 'mia', password: 'long enough pass' })))
  expect(await view.findByText('the app')).toBeTruthy()
  expect(location.search).toBe('')
})

it('lets an owner invite someone and disable a person', async () => {
  vi.spyOn(api, 'people').mockResolvedValue({ users: [owner.account, person('mia', 'member')] })
  const invite = vi.spyOn(api, 'invitePerson').mockResolvedValue({ code: 'ABCDE-FGHJK', expiresAt: '2026-11-13T00:00:00Z', role: 'admin' })
  const update = vi.spyOn(api, 'updatePerson').mockResolvedValue({ user: person('mia', 'member', { disabled: true }) })
  const view = render(createElement(People, { me: owner.account }))
  expect(await view.findByText('mia')).toBeTruthy()
  // Nobody changes their own role or switches themselves off here.
  expect(view.queryByRole('button', { name: 'Disable Ocean' })).toBeNull()
  fireEvent.click(view.getByRole('radio', { name: 'Admin' }))
  fireEvent.click(view.getByRole('button', { name: 'Create invite link' }))
  await waitFor(() => expect(invite).toHaveBeenCalledWith('admin'))
  expect(await view.findByDisplayValue(/\/\?invite=ABCDE-FGHJK$/u)).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: 'Disable Mia' }))
  await waitFor(() => expect(update).toHaveBeenCalledWith('id-mia', { disabled: true }))
  expect(await view.findByText('Disabled')).toBeTruthy()
})

it('signs out and changes the password', async () => {
  const signOut = vi.spyOn(api, 'signOut').mockResolvedValue({ signedOut: true })
  const change = vi.spyOn(api, 'changePassword').mockResolvedValue({ changed: true })
  const onSignedOut = vi.fn()
  const view = render(createElement(AccountSettings, { session: member, onSignedOut }))
  // A member manages nobody.
  expect(view.queryByText('People')).toBeNull()
  expect(view.getByText('/srv/members/mia')).toBeTruthy()
  fireEvent.change(view.getByLabelText('Current password'), { target: { value: 'old password!' } })
  fireEvent.change(view.getByLabelText('New password'), { target: { value: 'a new long password' } })
  fireEvent.click(view.getByRole('button', { name: 'Change password' }))
  await waitFor(() => expect(change).toHaveBeenCalledWith('old password!', 'a new long password'))
  expect(await view.findByText(/other devices were signed out/)).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: 'Sign out' }))
  await waitFor(() => expect(signOut).toHaveBeenCalled())
  expect(onSignedOut).toHaveBeenCalled()
})

it('shows a member only the settings that are theirs', () => {
  const config: ConfigSnapshot = { apiKeySet: false, effective: { model: 'm', modelId: 'm', baseUrl: 'http://localhost' }, config: { path: '/c.json', apiKeySet: false }, env: { apiKeySet: false }, models: [] }
  const view = render(createElement(AccountContext.Provider, { value: member }, createElement(SettingsDialog, { config, onClose: vi.fn(), onSaved: vi.fn() })))
  const tabs = view.getAllByRole('tab').map(tab => tab.textContent)
  expect(tabs).toContain('Account')
  expect(tabs).toContain('Secrets')
  expect(tabs).not.toContain('Models')
  expect(tabs).not.toContain('Tools & shell')
  expect(view.queryByRole('button', { name: 'Save changes' })).toBeNull()
})

it('puts Account first and Server right after it for an owner, and opens on Account', () => {
  const config: ConfigSnapshot = { apiKeySet: false, effective: { model: 'm', modelId: 'm', baseUrl: 'http://localhost' }, config: { path: '/c.json', apiKeySet: false }, env: { apiKeySet: false }, models: [] }
  vi.spyOn(api, 'adminOverview').mockResolvedValue({ people: [], devices: [] })
  vi.spyOn(api, 'people').mockResolvedValue({ users: [] })
  const view = render(createElement(AccountContext.Provider, { value: owner }, createElement(SettingsDialog, { config, onClose: vi.fn(), onSaved: vi.fn() })))
  const tabs = view.getAllByRole('tab').map(tab => tab.textContent)
  expect(tabs.slice(0, 3)).toEqual(['Account', 'Server', 'Models'])
  expect(view.getByRole('tab', { name: 'Account' }).getAttribute('aria-selected')).toBe('true')
})

it('keeps Server away from members', () => {
  const config: ConfigSnapshot = { apiKeySet: false, effective: { model: 'm', modelId: 'm', baseUrl: 'http://localhost' }, config: { path: '/c.json', apiKeySet: false }, env: { apiKeySet: false }, models: [] }
  const view = render(createElement(AccountContext.Provider, { value: member }, createElement(SettingsDialog, { config, onClose: vi.fn(), onSaved: vi.fn() })))
  expect(view.getAllByRole('tab').map(tab => tab.textContent)).not.toContain('Server')
})

it('shows devices and boxes on the Server page, and signs out a device and stops a box', async () => {
  const mia = person('mia', 'member')
  const overview: AdminOverview = {
    people: [owner.account, mia],
    devices: [
      { id: 'd1', accountId: 'id-mia', kind: 'daemon', name: 'mia-laptop', connected: true, box: false },
      { id: 'd2', accountId: 'id-ocean', kind: 'client', name: 'Chrome on macOS', lastSeen: new Date().toISOString(), connected: false, box: false },
      { id: 'd3', accountId: 'id-mia', kind: 'daemon', name: 'box', connected: true, box: true },
    ],
    boxes: { provider: 'gvisor', maxRunning: 3, list: [{ id: 'b1', accountId: 'id-mia', workspace: '/srv/members/mia', provider: 'gvisor', state: 'running', lastUsed: new Date().toISOString(), connected: true }] },
  }
  const load = vi.spyOn(api, 'adminOverview').mockResolvedValue(overview)
  vi.spyOn(api, 'people').mockResolvedValue({ users: [owner.account, mia] })
  const revoke = vi.spyOn(api, 'revokeDevice').mockResolvedValue({ revoked: 'd1' })
  const pause = vi.spyOn(api, 'pauseBox').mockResolvedValue({ id: 'b1' })
  const stop = vi.spyOn(api, 'stopBox').mockResolvedValue({ id: 'b1' })
  const view = render(createElement(ServerAdmin, { me: owner.account }))
  expect(await view.findByText('mia-laptop')).toBeTruthy()
  expect(view.getByText('1 of 3 running · gvisor')).toBeTruthy()
  // A box's own daemon is listed with the box, not as a device.
  expect(view.queryByText('box')).toBeNull()
  expect(view.getByText('Connected')).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: 'Sign out mia-laptop of Mia' }))
  await waitFor(() => expect(revoke).toHaveBeenCalledWith('id-mia', 'd1'))
  fireEvent.click(await view.findByRole('button', { name: "Pause Mia's box" }))
  await waitFor(() => expect(pause).toHaveBeenCalledWith('b1'))
  fireEvent.click(await view.findByRole('button', { name: "Stop Mia's box" }))
  await waitFor(() => expect(stop).toHaveBeenCalledWith('b1'))
  expect(load.mock.calls.length).toBeGreaterThanOrEqual(4)
})

it('lets an admin sign out only members\' devices', async () => {
  const ada = person('ada', 'admin')
  vi.spyOn(api, 'adminOverview').mockResolvedValue({
    people: [owner.account, ada, person('mia', 'member')],
    devices: [
      { id: 'd1', accountId: 'id-mia', kind: 'client', name: 'mia-phone', connected: false, box: false },
      { id: 'd2', accountId: 'id-ocean', kind: 'client', name: 'ocean-laptop', connected: false, box: false },
    ],
  })
  vi.spyOn(api, 'people').mockResolvedValue({ users: [] })
  const view = render(createElement(ServerAdmin, { me: ada }))
  expect(await view.findByText('ocean-laptop')).toBeTruthy()
  expect(view.getByRole('button', { name: 'Sign out mia-phone of Mia' })).toBeTruthy()
  expect(view.queryByRole('button', { name: 'Sign out ocean-laptop of Ocean' })).toBeNull()
  // A server without boxes says so and lists none.
  expect(view.getByText('Off')).toBeTruthy()
  expect(view.queryByRole('heading', { name: 'Boxes' })).toBeNull()
})

it('keeps the Account section off a local host', () => {
  const config: ConfigSnapshot = { apiKeySet: false, effective: { model: 'm', modelId: 'm', baseUrl: 'http://localhost' }, config: { path: '/c.json', apiKeySet: false }, env: { apiKeySet: false }, models: [] }
  const view = render(createElement(SettingsDialog, { config, onClose: vi.fn(), onSaved: vi.fn() }))
  const tabs = view.getAllByRole('tab').map(tab => tab.textContent)
  expect(tabs).not.toContain('Account')
  expect(tabs).toContain('Models')
})
