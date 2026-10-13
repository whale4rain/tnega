// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { projectApi } from '../../lib/project-api'
import { fromSnapshot } from '../../lib/project-model'
import type { ProjectSnapshot, ThreadRecord } from '../../lib/project-types'
import { INITIAL_WORKBENCH } from '../../lib/workbench'
import { ProjectView } from './ProjectView'
import { ThreadPanel } from './ThreadPanel'

vi.mock('../../lib/project-api', async importOriginal => {
  const original = await importOriginal<typeof import('../../lib/project-api')>()
  return { ...original, followProject: vi.fn(() => () => {}) }
})
vi.mock('../BackgroundJobs', () => ({ BackgroundJobs: () => null }))
vi.mock('../Timeline', () => ({ Timeline: () => null }))

afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear() })

it('opens file references from Project chat in the shared Workbench', async () => {
  const initial = snapshot()
  initial.messages = [{ messageId: 'answer', projectId: 'project', sender: { kind: 'agent', id: 'coordinator' },
    recipients: [{ kind: 'user', id: 'user' }], placement: { kind: 'main' }, kind: 'agent-reply',
    text: 'Updated docs/brief.md. See [report](reports/draft.pdf) and [site](https://example.com).', refs: [], createdAt: 2 }]
  vi.spyOn(projectApi, 'snapshot').mockResolvedValue(initial)
  const onWorkbench = vi.fn()
  const view = render(createElement(ProjectView, {
    workspace: '/repo', projectId: 'project', threadId: undefined, config: undefined,
    onOpenThread: vi.fn(), onDeleted: vi.fn(), onChanged: vi.fn(), sidebarOpen: true,
    onToggleSidebar: vi.fn(), workbench: INITIAL_WORKBENCH, onWorkbench,
    panelSlot: null, onPanelTabs: vi.fn(),
  }))
  fireEvent.click(await view.findByText('docs/brief.md'))
  expect(onWorkbench.mock.calls[0]![0](INITIAL_WORKBENCH)).toMatchObject({ active: 'files', focus: { path: 'docs/brief.md' } })
  fireEvent.click(view.getByText('report'))
  expect(onWorkbench.mock.calls[1]![0](INITIAL_WORKBENCH)).toMatchObject({ active: 'preview:reports/draft.pdf' })
  expect(view.getByText('site').closest('a')?.getAttribute('target')).toBe('_blank')
})

function thread(id: string): ThreadRecord {
  return { id, projectId: 'project', label: id, goal: 'Investigate', state: 'working', depth: 1,
    permission: 'workspace-write', createdAt: 1, updatedAt: 1 }
}

function snapshot(): ProjectSnapshot {
  return {
    project: { id: 'project', name: 'Project', coordinatorId: 'coordinator', createdAt: 1, updatedAt: 1 },
    coordinatorId: 'coordinator', cursor: 1,
    threads: [{ ...thread('coordinator'), depth: 0 }, { ...thread('worker'), parentId: 'coordinator' }],
    messages: [{ messageId: 'dispatch', projectId: 'project', sender: { kind: 'agent', id: 'coordinator' },
      recipients: [{ kind: 'user', id: 'user' }], placement: { kind: 'main' }, kind: 'dispatch', threadId: 'worker',
      text: 'Start work', refs: [], createdAt: 1 }],
    inboxMessages: [], memory: [], library: { artifacts: [], resources: [] },
  }
}

it('keeps separate agent chat bubbles and aligns the user on the opposite side', async () => {
  const initial = snapshot()
  const base = { projectId: 'project', recipients: [{ kind: 'user' as const, id: 'user' as const }], placement: { kind: 'main' as const }, refs: [] }
  initial.messages = [
    { ...base, messageId: 'user-1', sender: { kind: 'user', id: 'user' }, kind: 'user-message', text: 'Please investigate', createdAt: 1 },
    { ...base, messageId: 'agent-1', sender: { kind: 'agent', id: 'coordinator' }, kind: 'agent-reply', text: 'I found the cause.', createdAt: 2 },
    { ...base, messageId: 'agent-2', sender: { kind: 'agent', id: 'coordinator' }, kind: 'agent-reply', text: 'The fix is ready.', createdAt: 3 },
  ]
  vi.spyOn(projectApi, 'snapshot').mockResolvedValue(initial)
  const view = render(createElement(ProjectView, {
    workspace: 'workspace', projectId: 'project', threadId: undefined, config: undefined,
    onOpenThread: vi.fn(), onDeleted: vi.fn(), onChanged: vi.fn(), sidebarOpen: true,
    onToggleSidebar: vi.fn(), workbench: INITIAL_WORKBENCH, onWorkbench: vi.fn(),
    panelSlot: null, onPanelTabs: vi.fn(),
  }))
  const user = await view.findByText('Please investigate')
  expect(user.closest('.room-run')?.classList.contains('room-run-user')).toBe(true)
  const first = view.getByText('I found the cause.').closest('.room-message')
  const second = view.getByText('The fix is ready.').closest('.room-message')
  expect(first).not.toBe(second)
  expect(first?.closest('.room-run')?.classList.contains('room-run-agent')).toBe(true)
})

it('shows tool-published Thread messages after loading a snapshot', async () => {
  const initial = snapshot()
  initial.threadMessages = [
    { messageId: 'thread-user', projectId: 'project', sender: { kind: 'user', id: 'user' }, recipients: [{ kind: 'agent', id: 'worker' }], placement: { kind: 'thread', threadId: 'worker' }, kind: 'user-thread', text: 'Check the parser', refs: [], createdAt: 2 },
    { messageId: 'thread-note', projectId: 'project', sender: { kind: 'agent', id: 'worker' }, recipients: [{ kind: 'user', id: 'user' }], placement: { kind: 'thread', threadId: 'worker' }, kind: 'agent-reply', text: 'The parser has a boundary bug.', refs: [], createdAt: 3 },
  ]
  vi.spyOn(projectApi, 'thread').mockResolvedValue({ thread: initial.threads[1]!, events: [] })
  const view = render(createElement(ThreadPanel, { workspace: 'workspace', state: fromSnapshot(initial), threadId: 'worker', onBack: vi.fn() }))
  expect(await view.findByText('The parser has a boundary bug.')).toBeTruthy()
  expect(view.getByText('Check the parser').closest('.room-run')?.classList.contains('room-run-user')).toBe(true)
})

it('folds what the coordinator sent a thread into one-line notes that open on click', async () => {
  const initial = snapshot()
  const worker = initial.threads[1]!
  initial.agentMessages = [
    { messageId: 'brief', projectId: 'project', sender: { kind: 'agent', id: 'coordinator' }, recipients: [{ kind: 'agent', id: 'worker' }], placement: { kind: 'main' }, kind: 'dispatch', threadId: 'worker', text: `${worker.goal}\n\nExpected result: a fix`, refs: [], createdAt: 2 },
    { messageId: 'nudge', projectId: 'project', sender: { kind: 'agent', id: 'coordinator' }, recipients: [{ kind: 'agent', id: 'worker' }], placement: { kind: 'main' }, kind: 'request', text: 'Keep the patch small.', refs: [], createdAt: 3 },
    { messageId: 'report', projectId: 'project', sender: { kind: 'agent', id: 'worker' }, recipients: [{ kind: 'agent', id: 'coordinator' }], placement: { kind: 'main' }, kind: 'complete', text: 'Report for the coordinator only.', refs: [], createdAt: 4 },
  ]
  vi.spyOn(projectApi, 'thread').mockResolvedValue({ thread: worker, events: [] })
  const view = render(createElement(ThreadPanel, { workspace: 'workspace', state: fromSnapshot(initial), threadId: 'worker', onBack: vi.fn() }))
  const note = await view.findByRole('button', { name: 'Message from Coordinator' })
  expect(note.getAttribute('aria-expanded')).toBe('false')
  expect(view.queryByText('Keep the patch small.')).toBeNull()
  fireEvent.click(note)
  expect(note.getAttribute('aria-expanded')).toBe('true')
  expect(view.getByText('Keep the patch small.').closest('.relay-note-body')).toBeTruthy()
  // The dispatch is the brief: one folded note named for it, and no second folded copy.
  expect(view.getByRole('button', { name: 'Brief from Coordinator' })).toBeTruthy()
  expect(view.queryByRole('button', { name: 'Brief' })).toBeNull()
  expect(view.queryByText('Report for the coordinator only.')).toBeNull()
})

it('shows reactions under thread messages and toggles yours', async () => {
  const initial = snapshot()
  initial.threadMessages = [
    { messageId: 'thread-user', projectId: 'project', sender: { kind: 'user', id: 'user' }, recipients: [{ kind: 'agent', id: 'worker' }], placement: { kind: 'thread', threadId: 'worker' }, kind: 'user-thread', text: 'Thanks, looks good', refs: [], createdAt: 2 },
    { messageId: 'thread-note', projectId: 'project', sender: { kind: 'agent', id: 'worker' }, recipients: [{ kind: 'user', id: 'user' }], placement: { kind: 'thread', threadId: 'worker' }, kind: 'agent-reply', text: 'The fix is merged.', refs: [], createdAt: 3 },
  ]
  initial.reactions = [{ messageId: 'thread-user', emoji: '👍', by: { kind: 'agent', id: 'worker' }, createdAt: 4 }]
  vi.spyOn(projectApi, 'thread').mockResolvedValue({ thread: initial.threads[1]!, events: [] })
  const react = vi.spyOn(projectApi, 'react').mockResolvedValue({ reaction: null })
  const view = render(createElement(ThreadPanel, { workspace: 'workspace', state: fromSnapshot(initial), threadId: 'worker', onBack: vi.fn() }))
  const chip = await view.findByRole('button', { name: '👍 1: worker' })
  expect(chip.getAttribute('aria-pressed')).toBe('false')
  const report = view.getByText('The fix is merged.').closest('.room-message')!
  fireEvent.click(report.querySelector('button[aria-label="Add reaction"]')!)
  await act(async () => { fireEvent.click(view.getByRole('menuitem', { name: 'React 🎉' })) })
  expect(react).toHaveBeenLastCalledWith('workspace', 'project', 'thread-note', '🎉', true)
  expect(view.getByRole('button', { name: '🎉 1: You' }).getAttribute('aria-pressed')).toBe('true')
})

it('stops and corrects the coordinator, then redirects controls to a thread reply', async () => {
  vi.spyOn(projectApi, 'snapshot').mockResolvedValue(snapshot())
  const stop = vi.spyOn(projectApi, 'stopThread').mockResolvedValue({ stopped: true })
  const send = vi.spyOn(projectApi, 'send').mockResolvedValue({ messageId: 'correction', createdAt: 2 })
  const sendToThread = vi.spyOn(projectApi, 'sendToThread').mockResolvedValue({ messageId: 'worker-message', createdAt: 3 })
  const view = render(createElement(ProjectView, {
    workspace: 'workspace', projectId: 'project', threadId: undefined, config: undefined,
    onOpenThread: vi.fn(), onDeleted: vi.fn(), onChanged: vi.fn(), sidebarOpen: true,
    onToggleSidebar: vi.fn(), workbench: INITIAL_WORKBENCH, onWorkbench: vi.fn(),
    panelSlot: null, onPanelTabs: vi.fn(),
  }))
  const box = await view.findByRole('textbox', { name: 'Message' })
  expect(view.queryByRole('button', { name: 'Send' })).toBeNull()
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Stop' })) })
  expect(stop).toHaveBeenLastCalledWith('workspace', 'project', 'coordinator')
  fireEvent.change(box, { target: { value: 'Delegate the implementation' } })
  expect(view.queryByRole('button', { name: 'Stop' })).toBeNull()
  expect(view.queryByRole('button', { name: 'Interrupt and send' })).toBeNull()
  await act(async () => { fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true }) })
  expect(send).toHaveBeenCalledWith('workspace', 'project', 'Delegate the implementation', undefined, true)
  expect(view.getByText('Delegate the implementation')).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: 'Reply to worker' }))
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Stop' })) })
  expect(stop).toHaveBeenLastCalledWith('workspace', 'project', 'worker')
  fireEvent.change(box, { target: { value: 'Focus on the failing case' } })
  await act(async () => { fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true }) })
  expect(sendToThread).toHaveBeenCalledWith('workspace', 'project', 'worker', 'Focus on the failing case', true)
})

it('provides asynchronous messages, correction and composer stop in an active thread', async () => {
  vi.spyOn(projectApi, 'thread').mockResolvedValue({ thread: thread('worker'), events: [] })
  const send = vi.spyOn(projectApi, 'sendToThread').mockResolvedValue({ messageId: 'message', createdAt: 1 })
  const stop = vi.spyOn(projectApi, 'stopThread').mockResolvedValue({ stopped: true })
  const view = render(createElement(ThreadPanel, {
    workspace: 'workspace', state: fromSnapshot(snapshot()), threadId: 'worker', onBack: vi.fn(),
  }))
  const box = view.getByRole('textbox', { name: 'Message' })
  fireEvent.change(box, { target: { value: 'Use the existing module' } })
  await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }) })
  expect(send).toHaveBeenLastCalledWith('workspace', 'project', 'worker', 'Use the existing module', false)
  fireEvent.change(box, { target: { value: 'Stop editing and inspect first' } })
  await act(async () => { fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true }) })
  expect(send).toHaveBeenLastCalledWith('workspace', 'project', 'worker', 'Stop editing and inspect first', true)
  await act(async () => { fireEvent.keyDown(box, { key: 'Escape' }) })
  expect(stop).toHaveBeenCalledWith('workspace', 'project', 'worker')
})
