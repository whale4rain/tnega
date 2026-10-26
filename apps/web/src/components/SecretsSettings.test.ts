// @vitest-environment jsdom
import { createElement } from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import { SecretsSettings } from './SecretsSettings'

vi.mock('../lib/dialogs', () => ({ confirmDialog: vi.fn(async () => true) }))

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('lists the session and workspace secrets by name and removes one', async () => {
  const list = vi.spyOn(api, 'secrets').mockResolvedValue({ secrets: [
    { name: 'API_KEY', remembered: false },
    { name: 'GITHUB_TOKEN', remembered: true },
  ] })
  const remove = vi.spyOn(api, 'removeSecret').mockResolvedValue({ secrets: [{ name: 'API_KEY', remembered: false }] })
  const view = render(createElement(SecretsSettings, { workspace: '/work', sessionId: 'session-1' }))
  expect(await view.findByText('GITHUB_TOKEN')).toBeTruthy()
  expect(list).toHaveBeenCalledWith('/work', 'session-1', expect.anything())
  expect(view.getByText('Saved for this workspace')).toBeTruthy()
  expect(view.getByText('This session only')).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: 'Remove GITHUB_TOKEN' }))
  await waitFor(() => expect(remove).toHaveBeenCalledWith('/work', 'GITHUB_TOKEN', 'session-1'))
  await waitFor(() => expect(view.queryByText('GITHUB_TOKEN')).toBeNull())
})

it('says how secrets are added when there are none', async () => {
  vi.spyOn(api, 'secrets').mockResolvedValue({ secrets: [] })
  const view = render(createElement(SecretsSettings, { workspace: '/work' }))
  expect(await view.findByText(/No secrets yet/)).toBeTruthy()
})
