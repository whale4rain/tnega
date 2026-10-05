// @vitest-environment jsdom
import { createElement } from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import type { ConfigSnapshot } from '../lib/types'
import { SettingsDialog } from './SettingsDialog'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const snapshot: ConfigSnapshot = {
  apiKeySet: false, effective: { model: 'test', modelId: 'test', baseUrl: 'http://localhost' },
  config: { path: '/config.json', apiKeySet: false, approvalReview: { provider: 'jev', defaultMode: 'manual', apiKeySet: true, apiKeyEnv: 'JEV_SECRET' } },
  env: { apiKeySet: false }, models: [],
}

it('saves automatic review separately and clears unsaved credentials when switching provider', async () => {
  const save = vi.spyOn(api, 'saveConfig').mockResolvedValue(snapshot)
  const view = render(createElement(SettingsDialog, { config: snapshot, onClose: vi.fn(), onSaved: vi.fn() }))
  fireEvent.change(view.getByLabelText('Reviewer API key'), { target: { value: 'jev-only-secret' } })
  fireEvent.change(view.getByLabelText('Approval reviewer'), { target: { value: 'openai' } })
  expect(view.getByLabelText('Reviewer API key')).toHaveProperty('value', '')
  expect(view.getByLabelText('API key environment variable')).toHaveProperty('value', '')
  fireEvent.change(view.getByLabelText('Default approvals'), { target: { value: 'auto' } })
  fireEvent.click(view.getByText('Save changes'))
  await waitFor(() => expect(save).toHaveBeenCalledOnce())
  expect(save.mock.calls[0]?.[0].approvalReview).toMatchObject({ provider: 'openai', defaultMode: 'auto', apiKeyEnv: '' })
  expect(JSON.stringify(save.mock.calls)).not.toContain('jev-only-secret')
})

it('requires an explicit configured route before saving a model reviewer', async () => {
  const save = vi.spyOn(api, 'saveConfig').mockResolvedValue(snapshot)
  const view = render(createElement(SettingsDialog, { config: snapshot, onClose: vi.fn(), onSaved: vi.fn() }))
  fireEvent.change(view.getByLabelText('Approval reviewer'), { target: { value: 'model' } })
  fireEvent.click(view.getByText('Save changes'))
  expect(view.getByText('Select a configured model route for automatic review')).toBeTruthy()
  expect(save).not.toHaveBeenCalled()
})

it('offers exactly two CodeMode choices and saves the enabled state', async () => {
  const save = vi.spyOn(api, 'saveConfig').mockResolvedValue(snapshot)
  const view = render(createElement(SettingsDialog, { config: snapshot, onClose: vi.fn(), onSaved: vi.fn() }))
  const mode = view.getByLabelText('CodeMode')
  expect(mode).toHaveProperty('value', 'disabled')
  expect(mode.querySelectorAll('option')).toHaveLength(2)
  fireEvent.change(mode, { target: { value: 'enabled' } })
  fireEvent.click(view.getByText('Save changes'))
  await waitFor(() => expect(save).toHaveBeenCalledOnce())
  expect(save.mock.calls[0]?.[0].codeMode).toBe(true)
})

it('groups settings into sections and saves the chosen shell', async () => {
  localStorage.removeItem('tnega.settingsSection')
  const save = vi.spyOn(api, 'saveConfig').mockResolvedValue(snapshot)
  const withShells: ConfigSnapshot = { ...snapshot, shell: { active: 'PowerShell 7', available: [
    { path: 'C:/pwsh/pwsh.exe', label: 'PowerShell 7', kind: 'pwsh' },
    { path: 'C:/Git/bin/bash.exe', label: 'Git Bash', kind: 'bash' },
  ] } }
  const view = render(createElement(SettingsDialog, { config: withShells, onClose: vi.fn(), onSaved: vi.fn() }))
  expect(view.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Models', 'Usage', 'Approvals', 'Tools & shell', 'Appearance', 'About & updates'])
  expect(view.getByRole('tab', { name: 'Models' }).getAttribute('aria-selected')).toBe('true')
  fireEvent.click(view.getByRole('tab', { name: 'Tools & shell' }))
  expect(view.getByRole('tabpanel').id).toBe('settings-panel-tools')
  const shell = view.getByLabelText('Shell')
  expect(shell.querySelector('option')?.textContent).toBe('Automatic · PowerShell 7')
  fireEvent.change(shell, { target: { value: 'C:/Git/bin/bash.exe' } })
  fireEvent.click(view.getByText('Save changes'))
  await waitFor(() => expect(save).toHaveBeenCalledOnce())
  expect(save.mock.calls[0]?.[0].shell).toBe('C:/Git/bin/bash.exe')
})

it('jumps to the section holding an invalid field', () => {
  localStorage.removeItem('tnega.settingsSection')
  const view = render(createElement(SettingsDialog, { config: snapshot, onClose: vi.fn(), onSaved: vi.fn() }))
  fireEvent.click(view.getByRole('tab', { name: 'Approvals' }))
  fireEvent.change(view.getByLabelText('Temperature (all models)'), { target: { value: 'warm' } })
  fireEvent.click(view.getByText('Save changes'))
  expect(view.getByRole('alert').textContent).toBe('Temperature must be a number')
  expect(view.getByRole('tab', { name: 'Models' }).getAttribute('aria-selected')).toBe('true')
})

it('switches theme from Appearance right away', () => {
  const onThemeChange = vi.fn()
  const view = render(createElement(SettingsDialog, { config: snapshot, theme: 'system', onThemeChange, onClose: vi.fn(), onSaved: vi.fn() }))
  fireEvent.click(view.getByRole('tab', { name: 'Appearance' }))
  fireEvent.click(view.getByRole('radio', { name: 'Dark' }))
  expect(onThemeChange).toHaveBeenCalledWith('dark')
})

it('shows workspace usage with cache share and cost, and points at missing prices', async () => {
  localStorage.setItem('tnega.settingsSection', 'usage')
  const totals = (input: number) => ({ responses: 2, promptTokens: input, completionTokens: 1500, cachedTokens: input / 2, reasoningTokens: 0, cacheHitRate: 0.5 })
  vi.spyOn(api, 'usage').mockResolvedValue({
    today: { ...totals(12_000), cost: [{ amount: 0.12, currency: 'USD' }] },
    week: totals(40_000), total: totals(90_000),
    byModel: [{ ...totals(90_000), modelId: 'pro', name: 'Pro', priced: false }],
    sessions: 3,
  })
  const view = render(createElement(SettingsDialog, { config: snapshot, workspace: '/work', onClose: vi.fn(), onSaved: vi.fn() }))
  expect(await view.findByText('Today')).toBeTruthy()
  expect(view.getByText('$0.12')).toBeTruthy()
  expect(view.getAllByText('50%').length).toBeGreaterThan(0)
  expect(view.getByText(/No prices set for Pro/)).toBeTruthy()
  localStorage.removeItem('tnega.settingsSection')
})
