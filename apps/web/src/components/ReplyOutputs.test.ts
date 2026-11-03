// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Entry, ToolView } from '../lib/timeline'
import { LinkContext } from '../lib/links'
import { parseAction } from '../lib/reply'
import { Timeline, type TimelineActions } from './Timeline'

const fetchWorkspaceFile = vi.hoisted(() => vi.fn())
vi.mock('../lib/api', async original => ({ ...await original<typeof import('../lib/api')>(), fetchWorkspaceFile }))

beforeEach(() => {
  fetchWorkspaceFile.mockReset()
  fetchWorkspaceFile.mockImplementation(async (_workspace: string, path: string) => {
    if (path.includes('missing')) throw new Error('not found')
    return new Blob(['png'], { type: 'image/png' })
  })
  URL.createObjectURL = vi.fn(() => 'blob:image')
  URL.revokeObjectURL = vi.fn()
})
afterEach(cleanup)

function tool(name: string, args: unknown, output: unknown, callId = `${name}-1`): ToolView {
  return { callId, name, args, status: 'ok', output, durationMs: 4 }
}

function turn(id: string, tools: ToolView[], text = 'Here you go.'): Entry {
  return {
    kind: 'agent', id, turn: 1, status: 'done',
    blocks: [
      { kind: 'text', id: `${id}-text`, text },
      ...tools.map(each => ({ kind: 'tool' as const, id: each.callId, tool: each })),
    ],
  }
}

function view(entries: Entry[], actions: TimelineActions = {}, running = false) {
  return render(createElement(LinkContext.Provider, { value: { workspace: '/repo' } },
    createElement(Timeline, { entries, running, actions })))
}

const sent = tool('send_file', { paths: ['out/chart.png', 'report.pdf'] }, {
  sent: [
    { path: 'out/chart.png', name: 'chart.png', size: 3, kind: 'image' },
    { path: 'report.pdf', name: 'report.pdf', size: 2048, kind: 'file' },
  ],
})

it('shows sent images inline and other files as cards, not as steps', async () => {
  const onOpenFile = vi.fn()
  const page = view([turn('a', [sent])], { onOpenFile })
  await waitFor(() => expect(page.getByRole('img', { name: 'chart.png' })).toBeTruthy())
  expect(fetchWorkspaceFile).toHaveBeenCalledWith('/repo', 'out/chart.png', expect.anything())
  fireEvent.click(page.getByRole('button', { name: 'Open report.pdf' }))
  expect(onOpenFile).toHaveBeenCalledWith('report.pdf')
  expect(page.getByText('PDF · 2.0 KB')).toBeTruthy()
  expect(page.queryByRole('button', { name: /Sent/ })).toBeNull()
  // A click on the image opens it full size.
  fireEvent.click(page.getByRole('button', { name: 'Open chart.png' }))
  expect(page.getByRole('dialog', { name: 'chart.png' })).toBeTruthy()
})

it('falls back to a file card when a sent image is gone', async () => {
  const gone = tool('send_file', { paths: ['missing.png'] }, { sent: [{ path: 'missing.png', name: 'missing.png', size: 1, kind: 'image' }] })
  const page = view([turn('a', [gone])], { onOpenFile: vi.fn() })
  await waitFor(() => expect(page.getByText(/^PNG/)).toBeTruthy())
})

const form = tool('show_ui', {
  title: 'Pick a plan',
  components: [
    { id: 'root', component: 'Column', children: ['plan', 'name', 'agree', 'go'] },
    { id: 'plan', component: 'ChoicePicker', label: 'Plan', path: '/plan', options: [{ label: 'Free', value: 'free' }, { label: 'Pro', value: 'pro' }] },
    { id: 'name', component: 'TextField', label: 'Team name', path: '/team' },
    { id: 'agree', component: 'CheckBox', label: 'Send me updates', path: '/updates' },
    { id: 'go', component: 'Button', label: 'Continue', action: 'submit' },
  ],
  data: { plan: 'free' },
}, { shown: true, surface: 'form-1' }, 'form-1')

it('sends what the person filled in when they press a button, once', () => {
  const onUiAction = vi.fn()
  const page = view([{ kind: 'user', id: 'u', text: 'Set me up' }, turn('a', [form], 'Pick one:')], { onUiAction })
  expect(page.getByRole('region', { name: 'Pick a plan' })).toBeTruthy()
  expect(page.queryByRole('button', { name: /Showed a form/ })).toBeNull()
  fireEvent.click(page.getByRole('radio', { name: 'Pro' }))
  fireEvent.change(page.getByRole('textbox', { name: 'Team name' }), { target: { value: 'Rain' } })
  fireEvent.click(page.getByRole('checkbox', { name: 'Send me updates' }))
  fireEvent.click(page.getByRole('button', { name: 'Continue' }))
  expect(onUiAction).toHaveBeenCalledTimes(1)
  expect(parseAction(onUiAction.mock.calls[0]![0] as string)).toEqual({
    surface: 'form-1', action: 'submit', label: 'Continue', values: { plan: 'pro', team: 'Rain', updates: true },
  })
  expect((page.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true)
  expect(page.getByText('Sent · Continue')).toBeTruthy()
})

it('keeps an answered form with its answer, and shows the answer as what was pressed', () => {
  const answer = '[ui-action] {"surface":"form-1","action":"submit","label":"Continue","values":{"plan":"pro","team":"Rain","updates":false}}'
  const page = view([turn('a', [form]), { kind: 'user', id: 'u2', text: answer }], { onUiAction: vi.fn(), onEdit: vi.fn() })
  expect((page.getByRole('radio', { name: 'Pro' }) as HTMLInputElement).checked).toBe(true)
  expect((page.getByRole('textbox', { name: 'Team name' }) as HTMLInputElement).value).toBe('Rain')
  expect((page.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true)
  expect(page.getByText('Sent · Continue')).toBeTruthy()
  expect(page.queryByText(/ui-action/)).toBeNull()
  expect(page.getByText('Rain')).toBeTruthy()
  expect(page.queryByRole('button', { name: 'Edit and resend' })).toBeNull()
})

it('locks a form the conversation has moved past, and one in a running turn', () => {
  const older = view([turn('a', [form]), { kind: 'user', id: 'u2', text: 'Never mind' }], { onUiAction: vi.fn() })
  expect((older.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true)
  expect(older.getByText('No longer waiting for an answer')).toBeTruthy()
  cleanup()
  const live = view([turn('a', [form])], { onUiAction: vi.fn() }, true)
  expect((live.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true)
})
