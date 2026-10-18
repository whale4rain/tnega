// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import { projectApi } from '../lib/project-api'
import type { ProjectRecord } from '../lib/project-types'
import type { SessionSummary } from '../lib/types'
import { Sidebar } from './Sidebar'

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
