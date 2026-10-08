// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import type { ConfigSnapshot } from '../lib/types'
import { ModelRoutes } from './ModelRoutes'
import { ModelBrowser } from './ModelBrowser'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const snapshot = {
  apiKeySet: true,
  effective: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', modelId: 'deepseek-flash' },
  config: { apiKeySet: true, path: 'config.json', model: 'deepseek-flash', models: [] },
  env: { apiKeySet: false },
  models: [{ id: 'deepseek-flash', name: 'deepseek-flash', protocol: 'openai', reasoningEfforts: [], apiKeySet: true }],
} as unknown as ConfigSnapshot

it('lists the models, picks a default, and adds a route with an id derived from its name', async () => {
  const saved = vi.spyOn(api, 'saveModelRoute').mockResolvedValue(snapshot)
  const onDefault = vi.fn()
  const onChanged = vi.fn()
  const view = render(createElement(ModelRoutes, { config: snapshot, defaultId: 'deepseek-flash', onDefault, onChanged }))
  expect(view.getByText('Default')).toBeTruthy()

  fireEvent.click(view.getByRole('button', { name: 'Add model' }))
  fireEvent.change(view.getByLabelText('Connection'), { target: { value: 'openai' } })
  fireEvent.click(view.getByRole('button', { name: 'Enter model manually' }))
  fireEvent.change(view.getByPlaceholderText('DeepSeek Flash'), { target: { value: 'Claude Sonnet' } })
  fireEvent.change(view.getByPlaceholderText('deepseek-chat'), { target: { value: 'claude-sonnet-5-5' } })
  fireEvent.change(view.getByPlaceholderText('Paste the key for this model'), { target: { value: 'sk-test' } })
  fireEvent.click(view.getAllByRole('button', { name: 'Add model' }).at(-1)!)
  await vi.waitFor(() => expect(onChanged).toHaveBeenCalledWith(snapshot))
  expect(saved).toHaveBeenCalledWith('claude-sonnet', expect.objectContaining({ name: 'Claude Sonnet', model: 'claude-sonnet-5-5', apiKey: 'sk-test' }))
  expect(saved.mock.calls[0]?.[1].auth).toBeUndefined()
})

it('discovers models using a saved connection, disables duplicates, and reuses credentials on add', async () => {
  const config: ConfigSnapshot = { ...snapshot, config: { ...snapshot.config, models: [{ id: 'saved', model: 'already', name: 'Connected provider', apiKeySet: true, protocol: 'openai' }] } }
  const discover = vi.spyOn(api, 'discoverModels').mockResolvedValue({ source: 'provider', models: [{ id: 'already', name: 'Already added' }, { id: 'fresh', name: 'Fresh model', vision: true }] })
  const save = vi.spyOn(api, 'saveModelRoute').mockResolvedValue(snapshot)
  const onSaved = vi.fn()
  const view = render(createElement(ModelBrowser, { config, onSaved, onCancel: vi.fn() }))
  fireEvent.change(view.getByLabelText('Connection'), { target: { value: 'route:saved' } })
  fireEvent.click(view.getByRole('button', { name: 'Get models' }))
  expect(await view.findByRole('button', { name: 'Already added' })).toHaveProperty('disabled', true)
  fireEvent.click(view.getByRole('button', { name: 'Add Fresh model' }))
  await vi.waitFor(() => expect(onSaved).toHaveBeenCalledWith(snapshot, 'fresh'))
  expect(discover).toHaveBeenCalledWith({ routeId: 'saved' }, expect.any(AbortSignal))
  expect(save).toHaveBeenCalledWith('fresh', { model: 'fresh', name: 'Fresh model', source: 'provider', sourceRouteId: 'saved', vision: true })
})

it('discovers and copies a legacy top-level connection without asking for its saved key', async () => {
  const discover = vi.spyOn(api, 'discoverModels').mockResolvedValue({ source: 'third-party', models: [{ id: 'deepseek-flash', name: 'Already configured' }, { id: 'legacy-new', name: 'Legacy new' }] })
  const save = vi.spyOn(api, 'saveModelRoute').mockResolvedValue(snapshot)
  const view = render(createElement(ModelBrowser, { config: snapshot, onSaved: vi.fn(), onCancel: vi.fn() }))
  expect(view.getByLabelText('Connection')).toHaveProperty('value', 'route:deepseek-flash')
  fireEvent.click(view.getByRole('button', { name: 'Get models' }))
  expect(await view.findByRole('button', { name: 'Already added' })).toHaveProperty('disabled', true)
  fireEvent.click(await view.findByRole('button', { name: 'Add Legacy new' }))
  await vi.waitFor(() => expect(save).toHaveBeenCalledWith('legacy-new', { model: 'legacy-new', name: 'Legacy new', source: 'third-party', sourceRouteId: 'deepseek-flash' }))
  expect(discover).toHaveBeenCalledWith({ routeId: 'deepseek-flash' }, expect.any(AbortSignal))
})

it('shows discovery failure without removing the manual model form', async () => {
  vi.spyOn(api, 'discoverModels').mockRejectedValue(new Error('Sign in to ChatGPT first'))
  const view = render(createElement(ModelBrowser, { config: snapshot, onSaved: vi.fn(), onCancel: vi.fn() }))
  fireEvent.change(view.getByLabelText('Connection'), { target: { value: 'chatgpt' } })
  fireEvent.click(view.getByRole('button', { name: 'Get models' }))
  expect(await view.findByRole('alert')).toHaveProperty('textContent', 'Sign in to ChatGPT first')
  fireEvent.click(view.getByRole('button', { name: 'Enter model manually' }))
  expect(view.getByPlaceholderText('deepseek-chat')).toBeTruthy()
})

it('does not hide a model available through another account on the same endpoint', async () => {
  const config: ConfigSnapshot = { ...snapshot, config: { ...snapshot.config, models: [
    { id: 'account-one', model: 'old', apiKeySet: true, baseUrl: 'https://example.com/v1', protocol: 'openai' },
    { id: 'account-two', model: 'fresh', apiKeySet: true, baseUrl: 'https://example.com/v1', protocol: 'openai' },
  ] } }
  vi.spyOn(api, 'discoverModels').mockResolvedValue({ source: 'third-party', models: [{ id: 'fresh', name: 'Other account model' }] })
  const view = render(createElement(ModelBrowser, { config, onSaved: vi.fn(), onCancel: vi.fn() }))
  fireEvent.click(view.getByRole('button', { name: 'Get models' }))
  expect(await view.findByRole('button', { name: 'Add Other account model' })).toHaveProperty('disabled', false)
})

it.each([false, true])('keeps ChatGPT manual routes on their login without showing API credentials (copied=%s)', async copied => {
  const config: ConfigSnapshot = { ...snapshot, apiKeySet: copied, config: { ...snapshot.config, models: copied ? [{ id: 'chatgpt', model: 'one', apiKeySet: true, auth: 'chatgpt' }] : [] } }
  const save = vi.spyOn(api, 'saveModelRoute').mockResolvedValue(snapshot)
  vi.spyOn(api, 'chatgptLogin').mockResolvedValue({ status: 'signed-out' })
  const view = render(createElement(ModelBrowser, { config, onSaved: vi.fn(), onCancel: vi.fn() }))
  fireEvent.click(view.getByRole('button', { name: 'Enter model manually' }))
  expect(view.queryByLabelText('API key')).toBeNull()
  expect(view.queryByLabelText('Base URL')).toBeNull()
  expect(view.queryByLabelText('Protocol')).toBeNull()
  expect(view.getByText(/Uses your ChatGPT login/)).toBeTruthy()
  fireEvent.change(view.getByPlaceholderText('deepseek-chat'), { target: { value: 'gpt-manual' } })
  fireEvent.click(view.getByRole('button', { name: 'Add model' }))
  await vi.waitFor(() => expect(save).toHaveBeenCalled())
  expect(save.mock.calls[0]?.[1]).toMatchObject({ auth: 'chatgpt', model: 'gpt-manual' })
  expect(save.mock.calls[0]?.[1].apiKey).toBeUndefined()
  expect(save.mock.calls[0]?.[1].baseUrl).toBeUndefined()
  expect(save.mock.calls[0]?.[1].protocol).toBeUndefined()
})

it.each([
  ['openai', 'https://api.openai.com/v1'],
  ['anthropic', 'https://api.anthropic.com/v1'],
] as const)('pins the %s connection for discovery and saving instead of inheriting a gateway', async (protocol, baseUrl) => {
  const config: ConfigSnapshot = { ...snapshot, effective: { ...snapshot.effective, baseUrl: 'https://gateway.example/v1' } }
  const discover = vi.spyOn(api, 'discoverModels').mockResolvedValue({ source: 'provider', models: [{ id: 'official-model', name: 'Official' }] })
  const save = vi.spyOn(api, 'saveModelRoute').mockResolvedValue(config)
  const view = render(createElement(ModelBrowser, { config, onSaved: vi.fn(), onCancel: vi.fn() }))
  fireEvent.change(view.getByLabelText('Connection'), { target: { value: protocol } })
  fireEvent.change(view.getByLabelText('API key'), { target: { value: 'official-key' } })
  fireEvent.click(view.getByRole('button', { name: 'Get models' }))
  fireEvent.click(await view.findByRole('button', { name: 'Add Official' }))
  await vi.waitFor(() => expect(save).toHaveBeenCalledWith('official-model', expect.objectContaining({ protocol, baseUrl, apiKey: 'official-key' })))
  expect(discover).toHaveBeenCalledWith({ protocol, baseUrl, apiKey: 'official-key' }, expect.any(AbortSignal))
})

it.each([
  ['openai', 'https://api.openai.com/v1'],
  ['anthropic', 'https://api.anthropic.com/v1'],
] as const)('pins a manual %s route even when its URL field is cleared', async (protocol, baseUrl) => {
  const save = vi.spyOn(api, 'saveModelRoute').mockResolvedValue(snapshot)
  const view = render(createElement(ModelBrowser, { config: snapshot, onSaved: vi.fn(), onCancel: vi.fn() }))
  fireEvent.change(view.getByLabelText('Connection'), { target: { value: protocol } })
  fireEvent.click(view.getByRole('button', { name: 'Enter model manually' }))
  fireEvent.change(view.getByLabelText('Base URL'), { target: { value: '' } })
  fireEvent.change(view.getByLabelText('API key'), { target: { value: 'official-key' } })
  fireEvent.change(view.getByPlaceholderText('deepseek-chat'), { target: { value: 'manual-official' } })
  fireEvent.click(view.getByRole('button', { name: 'Add model' }))
  await vi.waitFor(() => expect(save).toHaveBeenCalledWith('manual-official', expect.objectContaining({ protocol, baseUrl, apiKey: 'official-key' })))
})
