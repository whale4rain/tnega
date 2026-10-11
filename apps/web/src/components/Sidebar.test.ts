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

  // Rows carry only a dot and a title; the time is in the tooltip.
  expect(view.container.querySelector('.session-time')).toBeNull()
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
