// @vitest-environment jsdom
import { createElement } from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import { WorkspacePrompt } from './WorkspacePrompt'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('loads, saves and clears the current workspace instructions', async () => {
  vi.spyOn(api, 'workspacePrompt').mockResolvedValue({ prompt: 'Old instructions' })
  const save = vi.spyOn(api, 'saveWorkspacePrompt').mockImplementation(async (_workspace, prompt) => ({ prompt }))
  const view = render(createElement(WorkspacePrompt, { workspace: '/work' }))
  const input = await view.findByDisplayValue('Old instructions')
  fireEvent.change(input, { target: { value: 'New instructions' } })
  fireEvent.click(view.getByRole('button', { name: 'Save instructions' }))
  await waitFor(() => expect(save).toHaveBeenCalledWith('/work', 'New instructions'))
  await view.findByRole('status')
  fireEvent.click(view.getByRole('button', { name: 'Clear instructions' }))
  await waitFor(() => expect(save).toHaveBeenCalledWith('/work', ''))
  await waitFor(() => expect(view.getByRole('textbox').getAttribute('disabled')).toBeNull())
  expect(view.getByRole('textbox')).toHaveProperty('value', '')
})
