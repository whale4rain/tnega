// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import type { ConfigSnapshot } from '../lib/types'
import { ModelRoutes } from './ModelRoutes'

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
  fireEvent.change(view.getByPlaceholderText('DeepSeek Flash'), { target: { value: 'Claude Sonnet' } })
  fireEvent.change(view.getByPlaceholderText('deepseek-chat'), { target: { value: 'claude-sonnet-5-5' } })
  fireEvent.change(view.getByPlaceholderText('Paste the key for this model'), { target: { value: 'sk-test' } })
  fireEvent.click(view.getAllByRole('button', { name: 'Add model' }).at(-1)!)
  await vi.waitFor(() => expect(onChanged).toHaveBeenCalledWith(snapshot))
  expect(saved).toHaveBeenCalledWith('claude-sonnet', expect.objectContaining({ name: 'Claude Sonnet', model: 'claude-sonnet-5-5', apiKey: 'sk-test' }))
})
