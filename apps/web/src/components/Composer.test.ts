// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { Composer, SessionControls, type RunSettings } from './Composer'

afterEach(cleanup)

const settings: RunSettings = { agentType: 'work', mode: 'auto', permission: 'read-only', approvalMode: 'manual', reasoningEffort: 'default' }
const models = [{ id: 'm1', name: 'Model One', protocol: 'openai' as const, reasoningEfforts: ['low' as const, 'high' as const], apiKeySet: true }]

it('folds the model, its effort and the mode into one model word, with no mode buttons', () => {
  const onSettingsChange = vi.fn()
  const view = render(createElement(Composer, {
    settings, onSettingsChange, models, defaultModelId: 'm1', commands: [], running: false, locked: false,
    onSubmit: () => true, onStop: () => {}, placeholder: 'Reply…',
  }))
  expect(view.queryByRole('button', { name: /^Agent:/ })).toBeNull()
  expect(view.queryByRole('button', { name: /^Access:/ })).toBeNull()
  expect(view.queryByRole('button', { name: /^Mode:/ })).toBeNull()
  expect(view.queryByRole('button', { name: /^Effort:/ })).toBeNull()
  expect(view.queryByRole('button', { name: /mode is on/ })).toBeNull()
  expect(view.queryByText(/to send/)).toBeNull()
  fireEvent.click(view.getByRole('button', { name: /^Model:/ }))
  expect(view.getByRole('group', { name: 'Reasoning effort' })).toBeTruthy()
  fireEvent.click(view.getByRole('option', { name: /High effort/ }))
  expect(onSettingsChange).toHaveBeenCalledWith({ reasoningEffort: 'high' })
  fireEvent.click(view.getByRole('button', { name: /^Model:/ }))
  fireEvent.click(view.getByRole('option', { name: /^Plan/ }))
  expect(onSettingsChange).toHaveBeenCalledWith({ mode: 'plan' })
})

it('names the chosen effort beside the model and offers no mode while a run is active', () => {
  const view = render(createElement(Composer, {
    settings: { ...settings, reasoningEffort: 'high' }, onSettingsChange: vi.fn(), models, defaultModelId: 'm1', commands: [],
    running: true, locked: true, modelLocked: false, onSubmit: () => true, onStop: () => {}, placeholder: 'Reply…',
  }))
  fireEvent.click(view.getByRole('button', { name: 'Model: Default model · High' }))
  expect(view.queryByRole('group', { name: 'Mode' })).toBeNull()
})

it('has no effort section for a model without effort levels', () => {
  const view = render(createElement(Composer, {
    settings, onSettingsChange: vi.fn(), models: [{ ...models[0]!, reasoningEfforts: [] }], defaultModelId: 'm1', commands: [],
    running: false, locked: false, onSubmit: () => true, onStop: () => {}, placeholder: 'Reply…',
  }))
  fireEvent.click(view.getByRole('button', { name: /^Model:/ }))
  expect(view.queryByRole('group', { name: 'Reasoning effort' })).toBeNull()
})

it('shows Plan mode while it is on and clears it back to Auto', () => {
  const onSettingsChange = vi.fn()
  const view = render(createElement(Composer, {
    settings: { ...settings, mode: 'plan' }, onSettingsChange, models, defaultModelId: 'm1', commands: [], running: false, locked: false,
    onSubmit: () => true, onStop: () => {}, placeholder: 'Reply…',
  }))
  fireEvent.click(view.getByRole('button', { name: 'Plan mode is on. Switch back to Auto' }))
  expect(onSettingsChange).toHaveBeenCalledWith({ mode: 'auto' })
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
