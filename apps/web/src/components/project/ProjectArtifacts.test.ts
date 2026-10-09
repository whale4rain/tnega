// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { createElement, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { ApiError } from '../../lib/api'
import { projectApi } from '../../lib/project-api'
import { fromSnapshot } from '../../lib/project-model'
import type { ArtifactFact, MemoryFact, ProjectSnapshot } from '../../lib/project-types'
import { INITIAL_WORKBENCH, enterProject, openDoc } from '../../lib/workbench'
import { MemoryPanel } from './ProjectPanels'
import { LibraryPanel } from './ProjectPanels'
import { ProjectView } from './ProjectView'
import { ArtifactViewer } from './Artifacts'
import * as api from '../../lib/api'

vi.mock('../../lib/project-api', async () => {
  const original: typeof import('../../lib/project-api') = await vi.importActual('../../lib/project-api')
  return { ...original, followProject: vi.fn(() => () => {}) }
})
vi.mock('../BackgroundJobs', () => ({ BackgroundJobs: () => null }))
vi.mock('../Timeline', () => ({ Timeline: () => null }))

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const artifact: ArtifactFact = { kind: 'artifact', id: 'snapshot-hash', seq: 1, version: 1, author: 'worker', source: {}, createdAt: 1, updatedAt: 1, deleted: false,
  data: { hash: 'snapshot-hash', title: 'report.pdf', size: 10, mediaType: 'application/pdf' } }
const memory: MemoryFact = { ...artifact, kind: 'memory', id: 'memory', data: { text: 'Original', tags: ['keep'] } }
const snapshot: ProjectSnapshot = { project: { id: 'p', name: 'P', coordinatorId: 'c', createdAt: 1, updatedAt: 1 }, coordinatorId: 'c', cursor: 1, threads: [], messages: [], inboxMessages: [], memory: [memory], library: { artifacts: [], resources: [] } }

it('deduplicates artifact documents by snapshot hash and removes them on leaving the project', () => {
  const first = openDoc(INITIAL_WORKBENCH, { kind: 'artifact', artifact, label: 'report.pdf' })
  const again = openDoc(first, { kind: 'artifact', artifact: { ...artifact, id: 'another-fact' }, label: 'Report' })
  expect(again.docs).toHaveLength(1)
  expect(again.active).toBe('artifact:snapshot-hash')
  expect(enterProject(again, undefined, 'p')).toMatchObject({ docs: [], active: 'files' })
})

it('keeps the edit version and draft after a concurrent memory update rejects the save', async () => {
  const history = vi.spyOn(projectApi, 'memoryHistory').mockResolvedValue({ history: [memory] })
  const edit = vi.spyOn(projectApi, 'editMemory').mockRejectedValue(new ApiError(409, 'Conflict'))
  const view = render(createElement(MemoryPanel, { workspace: '/repo', state: fromSnapshot(snapshot) }))
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Edit' })) })
  fireEvent.change(view.getByDisplayValue('Original'), { target: { value: 'My draft' } })
  const concurrent = { ...memory, version: 2, data: { text: 'Someone else', tags: ['new'] } }
  history.mockResolvedValue({ history: [memory, concurrent] })
  view.rerender(createElement(MemoryPanel, { workspace: '/repo', state: fromSnapshot({ ...snapshot, memory: [concurrent] }) }))
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Save' })) })
  expect(edit).toHaveBeenCalledWith('/repo', 'p', 'memory', { text: 'My draft', expectedVersion: 1, tags: ['keep'] })
  expect(view.getByDisplayValue('My draft')).toBeTruthy()
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Save' })) })
  expect(edit).toHaveBeenLastCalledWith('/repo', 'p', 'memory', { text: 'My draft', expectedVersion: 1, tags: ['keep'] })
})

it('opens an artifact beside its generating Thread without sending a message', async () => {
  const textArtifact = { ...artifact, data: { ...artifact.data, mediaType: 'text/plain' } }
  const worker = { id: 'worker', projectId: 'p', label: 'Research', goal: 'Research', state: 'idle' as const, depth: 1, permission: 'workspace-write' as const, createdAt: 1, updatedAt: 1 }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ artifact: textArtifact, thread: worker }))))
  vi.spyOn(projectApi, 'artifact').mockResolvedValue('Published line')
  vi.spyOn(projectApi, 'thread').mockResolvedValue({ thread: worker, events: [] })
  const send = vi.spyOn(projectApi, 'sendToThread')
  const artifactSend = vi.spyOn(projectApi, 'sendToArtifact').mockResolvedValue({ messageId: 'sent', createdAt: 3 })
  vi.spyOn(projectApi, 'snapshot').mockResolvedValue({ ...snapshot, library: { artifacts: [textArtifact], resources: [] }, messages: [
    { messageId: 'report', projectId: 'p', sender: { kind: 'agent', id: 'c' }, recipients: [{ kind: 'user', id: 'user' }], placement: { kind: 'main' }, kind: 'agent-reply', text: 'Full coordinator detail. '.repeat(40), refs: [{ ...textArtifact.data, hash: 'old-revision', artifactId: textArtifact.id }], createdAt: 2 },
  ] })
  const onWorkbench = vi.fn()
  const view = render(createElement(ProjectView, { workspace: '/repo', projectId: 'p', threadId: undefined, config: undefined,
    onOpenThread: vi.fn(), onDeleted: vi.fn(), onChanged: vi.fn(), sidebarOpen: true, onToggleSidebar: vi.fn(),
    workbench: INITIAL_WORKBENCH, onWorkbench, panelSlot: null, onPanelTabs: vi.fn() }))
  const card = await view.findByRole('button', { name: /report.pdf/ })
  expect(view.queryByRole('button', { name: 'Show more' })).toBeNull()
  expect(view.container.querySelector('.message-fold')).toBeNull()
  card.focus()
  fireEvent.click(card)
  expect(await view.findByRole('dialog')).toBeTruthy()
  expect(await view.findByPlaceholderText('Message Research…')).toBeTruthy()
  expect(await view.findByText('Published line')).toBeTruthy()
  expect(onWorkbench).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
  const dialog = within(view.getByRole('dialog'))
  const text = dialog.getByText('Published line')
  const range = document.createRange()
  range.selectNodeContents(text)
  document.getSelection()?.removeAllRanges()
  document.getSelection()?.addRange(range)
  fireEvent(document, new Event('selectionchange'))
  await waitFor(() => expect(dialog.getByRole('button', { name: 'Quote selection' }).hasAttribute('disabled')).toBe(false))
  fireEvent.click(dialog.getByRole('button', { name: 'Quote selection' }))
  expect(artifactSend).not.toHaveBeenCalled()
  fireEvent.click(dialog.getByRole('button', { name: 'Remove quote' }))
  expect(artifactSend).not.toHaveBeenCalled()
  document.getSelection()?.removeAllRanges()
  document.getSelection()?.addRange(range)
  fireEvent(document, new Event('selectionchange'))
  await waitFor(() => expect(dialog.getByRole('button', { name: 'Quote selection' }).hasAttribute('disabled')).toBe(false))
  fireEvent.click(dialog.getByRole('button', { name: 'Quote selection' }))
  fireEvent.change(dialog.getByPlaceholderText('Message Research…'), { target: { value: 'Revise this line' } })
  await act(async () => { fireEvent.click(dialog.getByRole('button', { name: 'Send' })) })
  expect(artifactSend).toHaveBeenCalledExactlyOnceWith('/repo', 'p', artifact.id, { text: 'Revise this line', hash: 'snapshot-hash', quote: 'Published line' })
  fireEvent.click(view.getByRole('button', { name: 'Close' }))
  await waitFor(() => expect(document.activeElement).toBe(card))
})

it('links Library outputs to the actual attached message, not just their author', () => {
  const source = { messageId: 'attachment', projectId: 'p', sender: { kind: 'agent' as const, id: 'worker' }, recipients: [{ kind: 'user' as const, id: 'user' as const }], placement: { kind: 'thread' as const, threadId: 'worker' }, kind: 'agent-reply' as const, text: 'Attached report', refs: [{ ...artifact.data, hash: 'old-revision', artifactId: artifact.id }], createdAt: 2 }
  const onOpenSource = vi.fn()
  const view = render(createElement(LibraryPanel, { workspace: '/repo', state: fromSnapshot({ ...snapshot, threadMessages: [source], library: { artifacts: [artifact, { ...artifact, id: 'unattached', data: { ...artifact.data, hash: 'unattached', title: 'No source' } }], resources: [] } }), onOpenSource }))
  fireEvent.click(view.getByRole('button', { name: 'Open source message' }))
  expect(onOpenSource).toHaveBeenCalledWith(source)
  expect(view.getAllByRole('button', { name: 'Open source message' })).toHaveLength(1)
})

it('opens and highlights the referenced Thread message from the Library', async () => {
  const worker = { id: 'worker', projectId: 'p', label: 'Research', goal: 'Research', state: 'idle' as const, depth: 1, permission: 'workspace-write' as const, createdAt: 1, updatedAt: 1 }
  const source = { messageId: 'attachment', projectId: 'p', sender: { kind: 'agent' as const, id: 'worker' }, recipients: [{ kind: 'user' as const, id: 'user' as const }], placement: { kind: 'thread' as const, threadId: 'worker' }, kind: 'agent-reply' as const, text: 'Attached report', refs: [{ ...artifact.data, hash: 'old-revision', artifactId: artifact.id }], createdAt: 2 }
  vi.spyOn(projectApi, 'snapshot').mockResolvedValue({ ...snapshot, threads: [worker], threadMessages: [source], library: { artifacts: [artifact], resources: [] } })
  vi.spyOn(projectApi, 'thread').mockResolvedValue({ thread: worker, events: [] })
  const slot = document.createElement('div')
  document.body.append(slot)
  function Harness() {
    const [workbench, setWorkbench] = useState({ ...INITIAL_WORKBENCH, open: true, active: 'project:library' })
    return createElement(ProjectView, { workspace: '/repo', projectId: 'p', threadId: undefined, config: undefined,
      onOpenThread: vi.fn(), onDeleted: vi.fn(), onChanged: vi.fn(), sidebarOpen: true, onToggleSidebar: vi.fn(),
      workbench, onWorkbench: setWorkbench, panelSlot: slot, onPanelTabs: vi.fn() })
  }
  const view = render(createElement(Harness))
  fireEvent.click(await view.findByRole('button', { name: 'Open source message' }))
  expect((await view.findByText('Attached report')).closest('.room-message')?.classList.contains('flash')).toBe(true)
  view.unmount()
  slot.remove()
})

it('previews the artifact snapshot bytes instead of reading the similarly named workspace file', async () => {
  const bytes = new Blob(['snapshot PDF'], { type: 'application/pdf' })
  const createObjectURL = vi.fn(() => 'blob:snapshot')
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = createObjectURL
    static revokeObjectURL = vi.fn()
  })
  const snapshotRead = vi.spyOn(projectApi, 'artifactBlob').mockResolvedValue(bytes)
  const fileRead = vi.spyOn(api, 'fetchWorkspaceFile')
  const view = render(createElement(ArtifactViewer, { workspace: '/repo', projectId: 'p', artifact }))
  await waitFor(() => expect(view.container.querySelector('iframe')?.getAttribute('src')).toBe('blob:snapshot'))
  expect(snapshotRead).toHaveBeenCalledWith('/repo', 'p', 'snapshot-hash')
  expect(createObjectURL).toHaveBeenCalledWith(bytes)
  expect(fileRead).not.toHaveBeenCalled()
  expect(view.queryByRole('dialog')).toBeNull()
})

