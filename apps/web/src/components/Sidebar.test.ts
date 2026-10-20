// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import { projectApi } from '../lib/project-api'
import type { ProjectRecord } from '../lib/project-types'
import type { SessionSummary } from '../lib/types'
import { Sidebar, type PickedSession } from './Sidebar'

beforeEach(() => localStorage.clear())
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const session = (id: string, workspace: string, updatedAt: number): SessionSummary =>
  ({ id, title: `Session ${id}`, workspace, createdAt: updatedAt, updatedAt, eventCount: 1 })
const project = (id: string, updatedAt: number, archived = false): ProjectRecord =>
  ({ id, name: `Project ${id}`, coordinatorId: `c-${id}`, createdAt: updatedAt, updatedAt, ...(archived ? { archived } : {}) })

function renderSidebar(overrides: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  const props: Parameters<typeof Sidebar>[0] = {
    workspaces: ['/a', '/b'],
    workspace: '/a',
    onAddWorkspace: vi.fn(),
    onRemoveWorkspace: vi.fn(),
    sessions: [session('a1', '/a', 2), session('a2', '/a', 1)],
    sessionsLoading: false,
    projects: [project('p1', 3)],
    projectsLoading: false,
    mode: 'sessions',
    selectedId: 'a1',
    selectedProjectId: undefined,
    onSelectSession: vi.fn(),
    onSelectProject: vi.fn(),
    onNewSession: vi.fn(),
    onNewProject: vi.fn(),
    onForkSession: vi.fn(),
    onDeleteSession: vi.fn(async () => true),
    onArchiveProject: vi.fn(async () => true),
    onDeleteProject: vi.fn(async () => true),
    onOpenSettings: vi.fn(),
    theme: 'system',
    onThemeChange: vi.fn(),
    onCollapse: vi.fn(),
    ...overrides,
  }
  return { props, view: render(createElement(Sidebar, props)) }
}

it('pins every project above workspace groups ordered by their latest session', async () => {
  vi.spyOn(api, 'sessions').mockResolvedValue({ sessions: [session('b1', '/b', 5)] })
  vi.spyOn(projectApi, 'list').mockResolvedValue({ projects: [project('pb', 9)] })
  const { props, view } = renderSidebar()

  // Projects from every workspace are pinned, newest first, without their workspace.
  await waitFor(() => expect(view.getByText('Project pb')).toBeTruthy())
  const pinned = view.getByRole('region', { name: 'Pinned' })
  expect([...pinned.querySelectorAll('.session-title > span:last-child')].map(node => node.textContent)).toEqual(['Project pb', 'Project p1'])

  // Rows carry only a mark and a title; the time is in the tooltip. Projects have an icon, not a dot.
  expect(view.container.querySelector('.session-time')).toBeNull()
  expect(pinned.querySelector('.session-dot')).toBeNull()
  expect(pinned.querySelectorAll('.project-icon')).toHaveLength(2)
  // The workspace with the newest session comes first; groups hold sessions only.
  const groups = view.container.querySelectorAll('.workspace-group')
  expect([...groups].map(group => group.querySelector('.workspace-name')?.textContent)).toEqual(['b', 'a'])
  expect([...groups[1]!.querySelectorAll('.session-title > span:last-child')].map(node => node.textContent))
    .toEqual(['Session a1', 'Session a2'])

  expect(api.sessions).toHaveBeenCalledWith('/b')
  fireEvent.click(view.getByText('Session b1'))
  expect(props.onSelectSession).toHaveBeenCalledWith('/b', 'b1')
  fireEvent.click(view.getByText('Project pb'))
  expect(props.onSelectProject).toHaveBeenCalledWith('/b', 'pb')
})

it('starts a new session in the default folder and names it plainly', () => {
  vi.spyOn(api, 'sessions').mockResolvedValue({ sessions: [] })
  vi.spyOn(projectApi, 'list').mockResolvedValue({ projects: [] })
  const { props, view } = renderSidebar({ workspaces: ['/a', '/home/.tnega/scratch'], defaultWorkspace: '/home/.tnega/scratch' })

  fireEvent.click(view.getByRole('button', { name: 'New session' }))
  expect(props.onNewSession).toHaveBeenCalledWith('/home/.tnega/scratch')
  expect(view.getByText('No folder')).toBeTruthy()
  // The default folder can't be removed from the list.
  expect(view.queryByRole('button', { name: 'No folder options' })).toBeNull()
})

it('remembers collapsed workspaces and keeps archived projects behind "archived"', async () => {
  vi.spyOn(api, 'sessions').mockResolvedValue({ sessions: [] })
  vi.spyOn(projectApi, 'list').mockResolvedValue({ projects: [] })
  const { view } = renderSidebar({ projects: [project('live', 2), project('old', 1, true)] })

  expect(view.queryByText('Project old')).toBeNull()
  fireEvent.click(view.getByText('1 archived'))
  expect(view.getByText('Project old')).toBeTruthy()

  const toggle = view.getAllByRole('button', { expanded: true }).find(button => button.textContent === 'b')!
  fireEvent.click(toggle)
  expect(JSON.parse(localStorage.getItem('tnega.sidebar.collapsed') ?? '[]')).toEqual(['/b'])
  cleanup()
  const again = renderSidebar().view
  expect(again.getAllByRole('button', { expanded: false }).map(button => button.textContent)).toContain('b')
})

it('collapses Pinned, shows a few projects before "more", and archives or deletes from the row menu', async () => {
  vi.spyOn(api, 'sessions').mockResolvedValue({ sessions: [] })
  vi.spyOn(projectApi, 'list').mockResolvedValue({ projects: [] })
  const many = Array.from({ length: 11 }, (_, index) => project(`m${index}`, 100 - index))
  many[10] = { ...project('m10', 90), threads: { waiting: 1, failed: 0, working: 0 } }
  const { props, view } = renderSidebar({ projects: many })

  // The first eight, plus one further down that waits on you.
  const pinned = view.getByRole('region', { name: 'Pinned' })
  expect(pinned.querySelectorAll('.project-item')).toHaveLength(9)
  expect(view.getByText('Project m10')).toBeTruthy()
  fireEvent.click(view.getByText('2 more'))
  expect(pinned.querySelectorAll('.project-item')).toHaveLength(11)

  fireEvent.click(view.getByRole('button', { name: 'Project m0 options' }))
  fireEvent.click(view.getByRole('menuitem', { name: /Delete/ }))
  expect(props.onDeleteProject).toHaveBeenCalledWith('/a', many[0])
  fireEvent.click(view.getByRole('button', { name: 'Project m1 options' }))
  fireEvent.click(view.getByRole('menuitem', { name: /Archive/ }))
  expect(props.onArchiveProject).toHaveBeenCalledWith('/a', many[1])

  fireEvent.click(view.getByRole('button', { name: 'Pinned' }))
  expect(pinned.querySelectorAll('.project-item')).toHaveLength(0)
  expect(JSON.parse(localStorage.getItem('tnega.sidebar.collapsed') ?? '[]')).toEqual(['\0pinned'])
})

it('turns a session row\'s dot into a light that says what needs you', async () => {
  vi.spyOn(api, 'sessions').mockResolvedValue({ sessions: [] })
  vi.spyOn(projectApi, 'list').mockResolvedValue({ projects: [] })
  const sessions: SessionSummary[] = [
    { ...session('busy', '/a', 3), running: true },
    { ...session('ask', '/a', 2), running: true, waiting: true },
    { ...session('rest', '/a', 1) },
  ]
  const { view } = renderSidebar({ sessions })
  const mark = (title: string) => view.getByText(title).closest('.session-item')!.querySelector('.session-mark .status-light')!

  expect(mark('Session busy').className).toContain('light-working')
  // An approval card outranks the run it pauses.
  expect(mark('Session ask').className).toContain('light-waiting')
  expect(mark('Session ask').getAttribute('aria-label')).toBe('Waiting on you')
  expect(mark('Session rest').className).toContain('light-idle')
  expect(view.container.querySelector('.session-dot')).toBeNull()
})

it('marks where a project\'s pull requests stand', () => {
  vi.spyOn(api, 'sessions').mockResolvedValue({ sessions: [] })
  vi.spyOn(projectApi, 'list').mockResolvedValue({ projects: [] })
  const withPrs: ProjectRecord = { ...project('pr', 5), pullRequests: [
    { url: 'https://github.com/o/r/pull/3', number: 3, threadId: 't1', state: 'merged' },
    { url: 'https://github.com/o/r/pull/2', number: 2, threadId: 't2', state: 'open' },
  ] }
  const { view } = renderSidebar({ projects: [withPrs, project('none', 4)] })
  const mark = view.getByRole('img', { name: /PR #3: merged/ })
  expect(mark.className).toContain('pr-open')
  expect(mark.getAttribute('aria-label')).toBe('PR #3: merged\nPR #2: open')
  expect(view.container.querySelectorAll('.pr-mark')).toHaveLength(1)
})

it('keeps showing a workspace\'s lists while the app loads them after a switch', async () => {
  vi.spyOn(api, 'sessions').mockResolvedValue({ sessions: [session('b1', '/b', 5)] })
  vi.spyOn(projectApi, 'list').mockResolvedValue({ projects: [project('pb', 9)] })
  const { props, view } = renderSidebar()
  await waitFor(() => expect(view.getByText('Project pb')).toBeTruthy())
  // The app moved to /b; its live lists still hold /a's until they load.
  view.rerender(createElement(Sidebar, { ...props, workspace: '/b', listsReady: false }))
  expect(view.getByText('Project pb')).toBeTruthy()
  expect(view.getByText('Project p1')).toBeTruthy()
  expect(view.getByText('Session a1')).toBeTruthy()
  expect(view.getByText('Session b1')).toBeTruthy()
})

it('puts New session and New project at the top, where you are', () => {
  vi.spyOn(api, 'sessions').mockResolvedValue({ sessions: [] })
  vi.spyOn(projectApi, 'list').mockResolvedValue({ projects: [] })
  const { props, view } = renderSidebar({ workspaces: ['/a', '/scratch'], defaultWorkspace: '/scratch' })
  fireEvent.click(view.getByRole('button', { name: 'New project' }))
  expect(props.onNewProject).toHaveBeenCalledWith('/a')
  fireEvent.click(view.getByRole('button', { name: 'New session' }))
  expect(props.onNewSession).toHaveBeenCalledWith('/scratch')
})

it('finds sessions by what was said in them and shows the matching line', async () => {
  vi.spyOn(api, 'sessions').mockResolvedValue({ sessions: [session('b1', '/b', 5)] })
  vi.spyOn(projectApi, 'list').mockResolvedValue({ projects: [] })
  const search = vi.spyOn(api, 'searchSessions').mockImplementation(async path =>
    ({ hits: path === '/b' ? [{ id: 'b1', snippet: '…the flaky login test…' }] : [] }))
  const { view } = renderSidebar()
  await waitFor(() => expect(view.getByText('Session b1')).toBeTruthy())

  fireEvent.change(view.getByRole('textbox', { name: 'Search sessions and projects' }), { target: { value: 'Login' } })
  // Titles filter at once; messages are asked of every workspace.
  expect(view.queryByText('Session a1')).toBeNull()
  await waitFor(() => expect(view.getByText('login')).toBeTruthy())
  expect(search).toHaveBeenCalledWith('/a', 'login', expect.any(AbortSignal))
  expect(search).toHaveBeenCalledWith('/b', 'login', expect.any(AbortSignal))
  const row = view.getByText('Session b1').closest('.session-item')!
  expect(row.querySelector('.session-snippet')?.textContent).toBe('…the flaky login test…')
  expect(row.querySelector('mark')?.textContent).toBe('login')

  fireEvent.change(view.getByRole('textbox', { name: 'Search sessions and projects' }), { target: { value: 'zzz' } })
  search.mockResolvedValue({ hits: [] })
  await waitFor(() => expect(view.getByText('Nothing matches “zzz”.')).toBeTruthy())
})

it('selects several sessions, across workspaces, and deletes them together', async () => {
  vi.spyOn(api, 'sessions').mockResolvedValue({ sessions: [session('b1', '/b', 5)] })
  vi.spyOn(projectApi, 'list').mockResolvedValue({ projects: [] })
  const onDeleteSessions = vi.fn((picked: PickedSession[]) => Promise.resolve(picked.length > 0))
  const sessions = [session('a1', '/a', 3), session('a2', '/a', 2), session('a3', '/a', 1)]
  const { props, view } = renderSidebar({ sessions, onDeleteSessions })
  await waitFor(() => expect(view.getByText('Session b1')).toBeTruthy())

  fireEvent.click(view.getAllByRole('button', { name: 'Session options' })[1]!)
  fireEvent.click(view.getByRole('menuitem', { name: /Select/ }))
  expect(view.getByText('1 selected')).toBeTruthy()
  // Rows become checkboxes; clicking one picks it instead of opening it, Shift picks a range.
  fireEvent.click(view.getByRole('checkbox', { name: /Session a3/ }), { shiftKey: true })
  expect(view.getByText('3 selected')).toBeTruthy()
  fireEvent.click(view.getByRole('checkbox', { name: /Session b1/ }))
  expect(props.onSelectSession).not.toHaveBeenCalled()
  expect(view.getByRole('checkbox', { name: /Session a2/ }).getAttribute('aria-checked')).toBe('true')

  fireEvent.click(view.getByRole('button', { name: /Delete/ }))
  await waitFor(() => expect(view.queryByRole('toolbar')).toBeNull())
  const picked = onDeleteSessions.mock.calls[0]![0]
  expect(picked.map(item => `${item.path}:${item.session.id}`).sort()).toEqual(['/a:a1', '/a:a2', '/a:a3', '/b:b1'])
})

it('keeps the selection when the delete is cancelled, and Escape leaves it', async () => {
  vi.spyOn(api, 'sessions').mockResolvedValue({ sessions: [] })
  vi.spyOn(projectApi, 'list').mockResolvedValue({ projects: [] })
  const onDeleteSessions = vi.fn((picked: PickedSession[]) => Promise.resolve(picked.length < 0))
  const { view } = renderSidebar({ onDeleteSessions })

  fireEvent.click(view.getByRole('button', { name: 'a options' }))
  fireEvent.click(view.getByRole('menuitem', { name: /Select sessions/ }))
  fireEvent.click(view.getByRole('button', { name: 'Select all' }))
  expect(view.getByText('2 selected')).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: /Delete/ }))
  await waitFor(() => expect(view.getByRole('button', { name: /Delete/ }).hasAttribute('disabled')).toBe(false))
  expect(onDeleteSessions).toHaveBeenCalled()
  expect(view.getByText('2 selected')).toBeTruthy()

  fireEvent.keyDown(window, { key: 'Escape' })
  expect(view.queryByRole('toolbar')).toBeNull()
  expect(view.getAllByRole('button', { name: 'Session options' })).toHaveLength(2)
})

it('refreshes every list when it opens and when the window comes back', async () => {
  const sessions = vi.spyOn(api, 'sessions').mockResolvedValue({ sessions: [] })
  vi.spyOn(projectApi, 'list').mockResolvedValue({ projects: [] })
  const onRefresh = vi.fn()
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    renderSidebar({ onRefresh })
    expect(onRefresh).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(sessions).toHaveBeenCalledTimes(1))

    // Too soon after the last refresh: nothing happens.
    window.dispatchEvent(new Event('focus'))
    expect(onRefresh).toHaveBeenCalledTimes(1)

    vi.setSystemTime(Date.now() + 5_000)
    window.dispatchEvent(new Event('focus'))
    expect(onRefresh).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(sessions).toHaveBeenCalledTimes(2))
    expect(sessions).toHaveBeenLastCalledWith('/b')
  } finally {
    vi.useRealTimers()
  }
})
