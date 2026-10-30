// @vitest-environment jsdom
import { createElement } from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import type { ConfigSnapshot, ContextInsights, InsightsRange, InsightsSession } from '../lib/types'
import { SettingsDialog } from './SettingsDialog'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const snapshot: ConfigSnapshot = {
  apiKeySet: false, effective: { model: 'test', modelId: 'test', baseUrl: 'http://localhost' },
  config: { path: '/config.json', apiKeySet: false, approvalReview: { provider: 'jev', defaultMode: 'manual', apiKeySet: true, apiKeyEnv: 'JEV_SECRET' } },
  env: { apiKeySet: false }, models: [],
}

it('saves memory route and shared limits with the other model settings', async () => {
  const config: ConfigSnapshot = { ...snapshot, config: { ...snapshot.config, models: [{ id: 'cheap', model: 'fast', name: 'Economical', apiKeySet: true }] } }
  const save = vi.spyOn(api, 'saveConfig').mockResolvedValue(config)
  const view = render(createElement(SettingsDialog, { config, onClose: vi.fn(), onSaved: vi.fn() }))
  fireEvent.change(view.getByLabelText('Delayed memory model'), { target: { value: 'cheap' } })
  fireEvent.change(view.getByLabelText('Memory calls per day'), { target: { value: '2' } })
  fireEvent.change(view.getByLabelText('Memory tokens per day'), { target: { value: '12000' } })
  fireEvent.change(view.getByLabelText('Memory input reservation per call'), { target: { value: '4096' } })
  fireEvent.change(view.getByLabelText('Memory output tokens per call'), { target: { value: '256' } })
  fireEvent.change(view.getByLabelText('Memory interval in seconds'), { target: { value: '600' } })
  fireEvent.click(view.getByLabelText('Automatic project memory'))
  fireEvent.click(view.getByText('Save changes'))
  await waitFor(() => expect(save).toHaveBeenCalledOnce())
  expect(save.mock.calls[0]?.[0].projectMemory).toEqual({ enabled: false, coldModelId: 'cheap', maxCallsPerDay: 2, maxTokensPerDay: 12000, maxInputTokens: 4096, maxOutputTokens: 256, minIntervalSeconds: 600 })
})

it('saves dreaming choices with the memory settings', async () => {
  const config: ConfigSnapshot = { ...snapshot, config: { ...snapshot.config, models: [{ id: 'cheap', model: 'fast', name: 'Economical', apiKeySet: true }] } }
  const save = vi.spyOn(api, 'saveConfig').mockResolvedValue(config)
  const view = render(createElement(SettingsDialog, { config, onClose: vi.fn(), onSaved: vi.fn() }))
  fireEvent.change(view.getByLabelText('Dreaming model'), { target: { value: 'cheap' } })
  fireEvent.change(view.getByLabelText('Quiet minutes before dreaming'), { target: { value: '30' } })
  fireEvent.click(view.getByLabelText('Dream from recent sessions'))
  fireEvent.click(view.getByText('Save changes'))
  await waitFor(() => expect(save).toHaveBeenCalledOnce())
  expect(save.mock.calls[0]?.[0].memoryDream).toEqual({ enabled: false, modelId: 'cheap', idleMinutes: 30 })
})

it('refuses a dreaming delay outside its range', async () => {
  const save = vi.spyOn(api, 'saveConfig').mockResolvedValue(snapshot)
  const view = render(createElement(SettingsDialog, { config: snapshot, onClose: vi.fn(), onSaved: vi.fn() }))
  fireEvent.change(view.getByLabelText('Quiet minutes before dreaming'), { target: { value: '0' } })
  fireEvent.click(view.getByText('Save changes'))
  expect(view.getByText('Quiet minutes must be a whole number from 1 to 1440')).toBeTruthy()
  expect(save).not.toHaveBeenCalled()
})

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

it('keeps computer use off unless chosen, and saves it once turned on', async () => {
  const save = vi.spyOn(api, 'saveConfig').mockResolvedValue(snapshot)
  const view = render(createElement(SettingsDialog, { config: snapshot, onClose: vi.fn(), onSaved: vi.fn() }))
  const computer = view.getByLabelText('Computer use')
  expect(computer).toHaveProperty('value', 'disabled')
  fireEvent.click(view.getByText('Save changes'))
  await waitFor(() => expect(save).toHaveBeenCalledOnce())
  expect(save.mock.calls[0]?.[0].computerUse).toBeUndefined()
  fireEvent.change(computer, { target: { value: 'enabled' } })
  fireEvent.click(view.getByText('Save changes'))
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
  expect(save.mock.calls[1]?.[0].computerUse).toBe(true)
})

it('shows the stored file write guard and saves the one chosen', async () => {
  const stored: ConfigSnapshot = { ...snapshot, config: { ...snapshot.config, fsGuard: 'off' } }
  const save = vi.spyOn(api, 'saveConfig').mockResolvedValue(stored)
  const view = render(createElement(SettingsDialog, { config: stored, onClose: vi.fn(), onSaved: vi.fn() }))
  const guard = view.getByLabelText('File write guard')
  expect(guard).toHaveProperty('value', 'off')
  expect(guard.querySelectorAll('option')).toHaveLength(3)
  fireEvent.change(guard, { target: { value: 'enforce' } })
  fireEvent.click(view.getByText('Save changes'))
  await waitFor(() => expect(save).toHaveBeenCalledOnce())
  expect(save.mock.calls[0]?.[0].fsGuard).toBe('enforce')
})

it('leaves the stored file write guard alone when another setting is saved', async () => {
  const save = vi.spyOn(api, 'saveConfig').mockResolvedValue(snapshot)
  // Opened before the config arrived: the guard shows the default, but saving
  // must not write it over whatever is stored.
  const view = render(createElement(SettingsDialog, { config: undefined, onClose: vi.fn(), onSaved: vi.fn() }))
  fireEvent.click(view.getByText('Save changes'))
  await waitFor(() => expect(save).toHaveBeenCalledOnce())
  expect(save.mock.calls[0]?.[0]).not.toHaveProperty('fsGuard')
})

it('groups settings into sections and saves the chosen shell', async () => {
  localStorage.removeItem('tnega.settingsSection')
  const save = vi.spyOn(api, 'saveConfig').mockResolvedValue(snapshot)
  const withShells: ConfigSnapshot = { ...snapshot, shell: { active: 'PowerShell 7', available: [
    { path: 'C:/pwsh/pwsh.exe', label: 'PowerShell 7', kind: 'pwsh' },
    { path: 'C:/Git/bin/bash.exe', label: 'Git Bash', kind: 'bash' },
  ] } }
  const view = render(createElement(SettingsDialog, { config: withShells, onClose: vi.fn(), onSaved: vi.fn() }))
  expect(view.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Models', 'Context insights', 'Instructions', 'Secrets', 'Approvals', 'Tools & shell', 'Appearance', 'About & updates'])
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

const composition = { system: 100, tools: 200, user: 50, injected: 0, assistant: 300, results: 1350 }
const timing = { activeMs: 90_000, waitingMs: 10_000, thinkingMs: 20_000, respondingMs: 15_000, toolMs: 30_000, otherMs: 15_000, modelCalls: 6, toolRuns: 4 }
function insights(range: InsightsRange, sessions: InsightsSession[]): ContextInsights {
  return {
    range, generatedAt: Date.now(), sessionCount: 3, activeSessions: sessions.length,
    totals: { promptTokens: 12_000, completionTokens: 1500, cachedTokens: 6000, cacheHitRate: 0.5, cost: [{ amount: 0.12, currency: 'USD' }], pricedSessions: 1, turns: 4, steps: 6, toolCalls: 4 },
    billed: { composition, output: 1500 }, timing,
    week: Array.from({ length: 7 }, (_, index) => ({ date: `2026-10-${String(15 + index).padStart(2, '0')}`, tokens: index * 100, steps: index })),
    activity: Array.from({ length: 84 }, (_, index) => ({ date: new Date(2026, 6, 30 + index).toISOString().slice(0, 10), tokens: index === 83 ? 500 : 0, steps: 0 })),
    sessions,
  }
}
const card = (id: string, title: string, kind: 'session' | 'thread' = 'session'): InsightsSession => ({
  id, kind, title, updatedAt: Date.now() - 60_000, window: 100_000, turns: 2, steps: 3, tokens: 4200, days: ['2026-10-21'],
  current: { estimate: composition, tokens: 2000, source: 'provider' }, lastMessage: `last words in ${title}`,
  ...(kind === 'thread' ? { projectId: 'p1', threadId: 't1' } : {}),
})

it('shows context insights for the stored range, remembers a new range, and opens a session', async () => {
  localStorage.setItem('tnega.settingsSection', 'usage')
  localStorage.removeItem('tnega.insightsRange')
  const totals = (input: number) => ({ responses: 2, promptTokens: input, completionTokens: 1500, cachedTokens: input / 2, reasoningTokens: 0, cacheHitRate: 0.5 })
  vi.spyOn(api, 'usage').mockResolvedValue({
    today: totals(12_000), week: totals(40_000), total: totals(90_000),
    byModel: [{ ...totals(90_000), modelId: 'pro', name: 'Pro', priced: false }],
    sessions: 3,
    responses: [],
  })
  const load = vi.spyOn(api, 'contextInsights').mockImplementation(async (_workspace, range) => insights(range, [card('s1', 'Fix the parser'), card('t1', 'Write the docs', 'thread')]))
  const onOpenSession = vi.fn()
  const view = render(createElement(SettingsDialog, { config: snapshot, workspace: '/work', onClose: vi.fn(), onSaved: vi.fn(), onOpenSession }))
  expect(await view.findByText('$0.12')).toBeTruthy()
  expect(load).toHaveBeenLastCalledWith('/work', '30d', expect.anything())
  expect(view.getByRole('radio', { name: 'Last 30 days' }).getAttribute('aria-checked')).toBe('true')
  expect(view.getByText(/No prices set for Pro/)).toBeTruthy()
  expect(view.getByRole('table')).toBeTruthy()

  fireEvent.click(view.getByRole('radio', { name: 'Last 7 days' }))
  await waitFor(() => expect(load).toHaveBeenLastCalledWith('/work', '7d', expect.anything()))
  expect(localStorage.getItem('tnega.insightsRange')).toBe('7d')

  fireEvent.change(await view.findByRole('searchbox', { name: 'Search sessions' }), { target: { value: 'docs' } })
  expect(view.queryByRole('button', { name: 'Open Fix the parser' })).toBeNull()
  fireEvent.click(view.getByRole('button', { name: 'Open Write the docs' }))
  expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ id: 't1', kind: 'thread', projectId: 'p1' }))
  localStorage.removeItem('tnega.settingsSection')
  localStorage.removeItem('tnega.insightsRange')
})

it('applies colour palette and display choices without saving the config', () => {
  localStorage.setItem('tnega.settingsSection', 'appearance')
  const save = vi.spyOn(api, 'saveConfig').mockResolvedValue(snapshot)
  const onDisplayChange = vi.fn()
  const view = render(createElement(SettingsDialog, {
    config: snapshot, onClose: vi.fn(), onSaved: vi.fn(),
    display: { palette: 'sky', density: 'compact', textSize: 'default', readingWidth: 'standard', glass: 'floating' }, onDisplayChange,
  }))
  const palettes = view.getByRole('radiogroup', { name: 'Colour palette' })
  expect([...palettes.querySelectorAll('[role="radio"] .palette-name')].map(name => name.textContent)).toEqual(['Carbon', 'Sky', 'Sand', 'Forest', 'Graphite'])
  expect(view.getByRole('radio', { name: /^Sky/ }).getAttribute('aria-checked')).toBe('true')
  fireEvent.click(view.getByRole('radio', { name: /^Graphite/ }))
  fireEvent.click(view.getByRole('radio', { name: 'Comfortable' }))
  fireEvent.click(view.getByRole('radio', { name: 'Large' }))
  fireEvent.click(view.getByRole('radio', { name: 'Full width' }))
  fireEvent.click(view.getByRole('radio', { name: 'Everywhere' }))
  expect(onDisplayChange.mock.calls).toEqual([['palette', 'graphite'], ['density', 'comfortable'], ['textSize', 'large'], ['readingWidth', 'full'], ['glass', 'full']])
  expect(save).not.toHaveBeenCalled()
})

it('saves listed command domains and says when this machine cannot enforce them', async () => {
  const config: ConfigSnapshot = { ...snapshot, sandbox: { network: { mode: 'open', allowedDomains: [], deniedDomains: [] } } }
  const save = vi.spyOn(api, 'saveConfig').mockResolvedValue(config)
  const support = vi.spyOn(api, 'sandboxNetwork').mockResolvedValue({ filtering: false, detail: 'socat is not installed' })
  const view = render(createElement(SettingsDialog, { config, onClose: vi.fn(), onSaved: vi.fn() }))
  fireEvent.click(view.getByRole('tab', { name: 'Tools & shell' }))
  expect(view.queryByLabelText('Allowed domains for commands')).toBeNull()
  expect(support).not.toHaveBeenCalled()

  fireEvent.click(view.getByRole('radio', { name: 'Listed domains only' }))
  expect(view.getByRole('radio', { name: 'Listed domains only' }).getAttribute('aria-checked')).toBe('true')
  fireEvent.change(view.getByLabelText('Allowed domains for commands'), { target: { value: 'github.com\n*.github.com\n' } })
  fireEvent.change(view.getByLabelText('Blocked domains for commands'), { target: { value: 'gist.github.com' } })
  await waitFor(() => expect(view.getByRole('status').textContent).toContain('cannot enforce it: socat is not installed'))

  fireEvent.click(view.getByText('Save changes'))
  await waitFor(() => expect(save).toHaveBeenCalledOnce())
  expect(save.mock.calls[0]?.[0].sandbox).toEqual({
    network: { mode: 'allowlist', allowedDomains: ['github.com', '*.github.com'], deniedDomains: ['gist.github.com'] },
  })
})

it('turns command network off without asking for domains', async () => {
  const config: ConfigSnapshot = { ...snapshot, sandbox: { network: { mode: 'allowlist', allowedDomains: ['a.dev'], deniedDomains: [] } } }
  const save = vi.spyOn(api, 'saveConfig').mockResolvedValue(config)
  vi.spyOn(api, 'sandboxNetwork').mockResolvedValue({ filtering: true, runner: 'bwrap' })
  const view = render(createElement(SettingsDialog, { config, onClose: vi.fn(), onSaved: vi.fn() }))
  fireEvent.click(view.getByRole('tab', { name: 'Tools & shell' }))
  expect(view.getByLabelText('Allowed domains for commands')).toHaveProperty('value', 'a.dev')
  fireEvent.click(view.getByRole('radio', { name: 'Off' }))
  expect(view.queryByLabelText('Allowed domains for commands')).toBeNull()
  await waitFor(() => expect(view.getByText('Enforced on this machine by bubblewrap.')).toBeTruthy())
  fireEvent.click(view.getByText('Save changes'))
  await waitFor(() => expect(save).toHaveBeenCalledOnce())
  expect(save.mock.calls[0]?.[0].sandbox).toEqual({ network: { mode: 'off', allowedDomains: ['a.dev'], deniedDomains: [] } })
})

it('does not save the open default over command network rules that arrived after the dialog opened', async () => {
  const save = vi.spyOn(api, 'saveConfig').mockResolvedValue(snapshot)
  const view = render(createElement(SettingsDialog, { config: undefined, onClose: vi.fn(), onSaved: vi.fn() }))
  const loaded: ConfigSnapshot = { ...snapshot, sandbox: { network: { mode: 'off', allowedDomains: [], deniedDomains: [] } } }
  view.rerender(createElement(SettingsDialog, { config: loaded, onClose: vi.fn(), onSaved: vi.fn() }))
  fireEvent.click(view.getByText('Save changes'))
  await waitFor(() => expect(save).toHaveBeenCalledOnce())
  expect(save.mock.calls[0]?.[0]).not.toHaveProperty('sandbox')
})

it('fills untouched command network fields from rules that arrive after the dialog opened', async () => {
  const save = vi.spyOn(api, 'saveConfig').mockResolvedValue(snapshot)
  vi.spyOn(api, 'sandboxNetwork').mockResolvedValue({ filtering: true, runner: 'bwrap' })
  const view = render(createElement(SettingsDialog, { config: undefined, onClose: vi.fn(), onSaved: vi.fn() }))
  const loaded: ConfigSnapshot = { ...snapshot, sandbox: { network: { mode: 'allowlist', allowedDomains: ['a.dev'], deniedDomains: ['old.dev'] } } }
  view.rerender(createElement(SettingsDialog, { config: loaded, onClose: vi.fn(), onSaved: vi.fn() }))
  fireEvent.click(view.getByRole('tab', { name: 'Tools & shell' }))
  expect(view.getByRole('radio', { name: 'Listed domains only' }).getAttribute('aria-checked')).toBe('true')
  expect(view.getByLabelText('Allowed domains for commands')).toHaveProperty('value', 'a.dev')
  fireEvent.change(view.getByLabelText('Blocked domains for commands'), { target: { value: 'gist.github.com' } })
  fireEvent.click(view.getByText('Save changes'))
  await waitFor(() => expect(save).toHaveBeenCalledOnce())
  expect(save.mock.calls[0]?.[0].sandbox).toEqual({ network: { mode: 'allowlist', allowedDomains: ['a.dev'], deniedDomains: ['gist.github.com'] } })
})
