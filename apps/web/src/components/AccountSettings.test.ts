// @vitest-environment jsdom
import { createElement } from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { api, ApiError } from '../lib/api'
import { AccountContext } from '../lib/account'
import type { AccountInfo, AuthSession, ConfigSnapshot } from '../lib/types'
import { AccountSettings } from './AccountSettings'
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
  const view = render(createElement(AccountSettings, { session: owner, onSignedOut: vi.fn() }))
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

it('keeps the Account section off a local host', () => {
  const config: ConfigSnapshot = { apiKeySet: false, effective: { model: 'm', modelId: 'm', baseUrl: 'http://localhost' }, config: { path: '/c.json', apiKeySet: false }, env: { apiKeySet: false }, models: [] }
  const view = render(createElement(SettingsDialog, { config, onClose: vi.fn(), onSaved: vi.fn() }))
  const tabs = view.getAllByRole('tab').map(tab => tab.textContent)
  expect(tabs).not.toContain('Account')
  expect(tabs).toContain('Models')
})
