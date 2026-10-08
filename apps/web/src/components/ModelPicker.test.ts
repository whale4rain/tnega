// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import type { ConfigSnapshot } from '../lib/types'
import { Composer, type RunSettings } from './Composer'
import { ModelPicker } from './ModelPicker'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const config: ConfigSnapshot = {
  apiKeySet: true, effective: { model: 'one', modelId: 'one', baseUrl: 'https://example.com/v1' },
  env: { apiKeySet: false }, config: { apiKeySet: true, path: 'config.json', models: [{ id: 'one', model: 'one', apiKeySet: true, protocol: 'openai', source: 'provider' }] },
  models: [{ id: 'one', name: 'Provider model', protocol: 'openai', apiKeySet: true, reasoningEfforts: ['high'], source: 'provider' },
    { id: 'proxy', name: 'Proxy model', protocol: 'openai', apiKeySet: true, reasoningEfforts: [], source: 'third-party' }],
}

it('groups models and adds from a Session picker without losing the draft or reasoning choice', async () => {
  const next: ConfigSnapshot = { ...config, models: [...config.models, { id: 'new', name: 'New model', protocol: 'openai', apiKeySet: true, reasoningEfforts: [], source: 'provider' }] }
  vi.spyOn(api, 'discoverModels').mockResolvedValue({ source: 'provider', models: [{ id: 'new', name: 'New model' }] })
  vi.spyOn(api, 'saveModelRoute').mockResolvedValue(next)
  const onSettingsChange = vi.fn()
  const onConfigChanged = vi.fn()
  const settings: RunSettings = { agentType: 'coding', mode: 'auto', permission: 'read-only', model: 'one', reasoningEffort: 'high' }
  const view = render(createElement(Composer, { settings, onSettingsChange, models: config.models, config, onConfigChanged,
    commands: [], running: false, locked: false, onSubmit: () => true, onStop: vi.fn(), placeholder: 'Draft' }))
  fireEvent.change(view.getByPlaceholderText('Draft'), { target: { value: 'Keep this unsent message' } })
  fireEvent.click(view.getByRole('button', { name: /^Model:/ }))
  expect(view.getByRole('group', { name: 'Model providers' })).toBeTruthy()
  expect(view.getByRole('group', { name: 'Third-party' })).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: 'Add model…' }))
  fireEvent.click(view.getByRole('button', { name: 'Get models' }))
  fireEvent.click(await view.findByRole('button', { name: 'Add New model' }))
  await vi.waitFor(() => expect(onSettingsChange).toHaveBeenCalledWith({ model: 'new' }))
  expect(onConfigChanged).toHaveBeenCalledWith(next)
  expect(view.getByPlaceholderText('Draft')).toHaveProperty('value', 'Keep this unsent message')
  expect(onSettingsChange).toHaveBeenCalledTimes(1)
  expect(view.queryByRole('dialog')).toBeNull()
  fireEvent.click(view.getByRole('button', { name: /^Model:/ }))
  expect(view.getByRole('option', { name: /New model/ })).toBeTruthy()
  view.rerender(createElement(Composer, { settings, onSettingsChange, models: config.models, config: { ...config }, onConfigChanged,
    commands: [], running: false, locked: false, onSubmit: () => true, onStop: vi.fn(), placeholder: 'Draft' }))
  expect(view.queryByRole('option', { name: /New model/ })).toBeNull()
  expect(view.getByRole('option', { name: /Provider model/ })).toBeTruthy()
})

it('keeps the empty picker usable and cancels an in-flight model discovery', async () => {
  const empty = { ...config, models: [], config: { ...config.config, models: [] } }
  let requestSignal: AbortSignal | undefined
  vi.spyOn(api, 'discoverModels').mockImplementation((_input, signal) => { requestSignal = signal; return new Promise(() => {}) })
  vi.spyOn(api, 'chatgptLogin').mockResolvedValue({ status: 'signed-out' })
  const view = render(createElement(ModelPicker, { models: [], config: empty, onChange: vi.fn() }))
  fireEvent.click(view.getByRole('button', { name: /^Model:/ }))
  fireEvent.click(view.getByRole('button', { name: 'Add model…' }))
  fireEvent.click(view.getByRole('button', { name: 'Get models' }))
  fireEvent.click(view.getByRole('button', { name: 'Cancel' }))
  expect(requestSignal?.aborted).toBe(true)
  expect(view.queryByRole('dialog')).toBeNull()
})
