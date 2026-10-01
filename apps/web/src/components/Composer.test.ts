// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { Composer, SessionControls, type RunSettings } from './Composer'

afterEach(cleanup)

const settings: RunSettings = { agentType: 'work', mode: 'auto', permission: 'read-only', approvalMode: 'manual', reasoningEffort: 'default' }
const models = [{ id: 'm1', name: 'Model One', protocol: 'openai' as const, reasoningEfforts: ['low' as const, 'high' as const], apiKeySet: true }]

it('keeps only mode and model in the composer, with effort inside the model menu', () => {
  const onSettingsChange = vi.fn()
  const view = render(createElement(Composer, {
    settings, onSettingsChange, models, defaultModelId: 'm1', commands: [], running: false, locked: false,
    onSubmit: () => true, onStop: () => {}, placeholder: 'Reply…',
  }))
  expect(view.queryByRole('button', { name: /^Agent:/ })).toBeNull()
  expect(view.queryByRole('button', { name: /^Access:/ })).toBeNull()
  expect(view.queryByText(/to send/)).toBeNull()
  fireEvent.click(view.getByRole('button', { name: /^Model:/ }))
  expect(view.getByRole('group', { name: 'Reasoning effort' })).toBeTruthy()
  fireEvent.click(view.getByRole('option', { name: /High effort/ }))
  expect(onSettingsChange).toHaveBeenCalledWith({ reasoningEffort: 'high' })
})

it('groups permissions and approvals in one header menu', () => {
  const onSettingsChange = vi.fn()
  const view = render(createElement(SessionControls, { settings: { ...settings, approvalMode: 'auto' }, onSettingsChange, locked: false }))
  const access = view.getByRole('button', { name: 'Access: Read only · Auto review' })
  fireEvent.click(access)
  fireEvent.click(view.getByRole('option', { name: /Workspace write/ }))
  expect(onSettingsChange).toHaveBeenCalledWith({ permission: 'workspace-write' })
  expect(view.getByRole('button', { name: 'Agent: Work' })).toBeTruthy()
})
