// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { Conversation } from './Conversation'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('enables CodeMode through slash completion and can disable it again', async () => {
  let enabled = false
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    expect(path).toBe('/api/config')
    if (init?.body) enabled = JSON.parse(String(init.body)).codeMode
    return Response.json({ config: { codeMode: enabled }, models: [], effective: {}, apiKeySet: true, env: {} })
  })
  const view = render(createElement(Conversation, {
    workspace: '/work', sessionId: undefined, config: undefined,
    draftSettings: { agentType: 'general', mode: 'auto', permission: 'read-only', approvalMode: 'manual', reasoningEffort: 'default' },
    onDraftSettingsChange: vi.fn(), onSessionCreated: vi.fn(), onSessionsChanged: vi.fn(),
    onSessionDeleted: vi.fn(), onOpenSettings: vi.fn(), onOpenSubagent: vi.fn(), onOpenFile: vi.fn(),
    sidebarOpen: true, onToggleSidebar: vi.fn(),
  }))
  const input = view.getByRole('textbox')
  if (!(input instanceof HTMLTextAreaElement)) throw new Error('Expected message textarea')
  fireEvent.change(input, { target: { value: '/code', selectionStart: 5 } })
  input.setSelectionRange(5, 5)
  fireEvent.select(input)
  expect(await view.findByRole('option', { name: /\/codemode/ })).toBeTruthy()
  fireEvent.change(input, { target: { value: '/codemode on', selectionStart: 12 } })
  fireEvent.keyDown(input, { key: 'Escape' })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(await view.findByText('CodeMode enabled (PTC).')).toBeTruthy()
  expect(enabled).toBe(true)
  fireEvent.change(input, { target: { value: '/codemode off', selectionStart: 13 } })
  fireEvent.keyDown(input, { key: 'Escape' })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(await view.findByText('CodeMode disabled.')).toBeTruthy()
  expect(enabled).toBe(false)
})

it('sends /btw to the temporary chat instead of the session', async () => {
  const fetch = vi.fn(async () => Response.json({}))
  vi.stubGlobal('fetch', fetch)
  const onAside = vi.fn()
  const view = render(createElement(Conversation, {
    workspace: '/work', sessionId: undefined, config: undefined,
    draftSettings: { agentType: 'general', mode: 'auto', permission: 'read-only', approvalMode: 'manual', reasoningEffort: 'default' },
    onDraftSettingsChange: vi.fn(), onSessionCreated: vi.fn(), onSessionsChanged: vi.fn(),
    onSessionDeleted: vi.fn(), onOpenSettings: vi.fn(), onOpenSubagent: vi.fn(), onOpenFile: vi.fn(),
    sidebarOpen: true, onToggleSidebar: vi.fn(), onAside,
  }))
  const input = view.getByRole('textbox')
  fireEvent.change(input, { target: { value: '/btw what does PTC mean?' } })
  fireEvent.keyDown(input, { key: 'Escape' })
  fireEvent.keyDown(input, { key: 'Enter' })
  await vi.waitFor(() => expect(onAside).toHaveBeenCalledWith('what does PTC mean?', undefined))
  // No session was created and nothing was sent to one.
  expect(fetch.mock.calls.some(call => String(call.at(0)).includes('/api/sessions'))).toBe(false)
})
