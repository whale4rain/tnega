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
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Stop' })) })
  expect(stop).toHaveBeenLastCalledWith('workspace', 'project', 'coordinator')
  fireEvent.change(box, { target: { value: 'Delegate the implementation' } })
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Interrupt and send' })) })
  expect(send).toHaveBeenCalledWith('workspace', 'project', 'Delegate the implementation', undefined, true)
  expect(view.getByText('Delegate the implementation')).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: 'Reply to worker' }))
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Stop' })) })
  expect(stop).toHaveBeenLastCalledWith('workspace', 'project', 'worker')
  fireEvent.change(box, { target: { value: 'Focus on the failing case' } })
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Interrupt and send' })) })
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
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Interrupt and send' })) })
  expect(send).toHaveBeenLastCalledWith('workspace', 'project', 'worker', 'Stop editing and inspect first', true)
  await act(async () => { fireEvent.keyDown(box, { key: 'Escape' }) })
  expect(stop).toHaveBeenCalledWith('workspace', 'project', 'worker')
})
