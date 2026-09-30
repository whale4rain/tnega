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
