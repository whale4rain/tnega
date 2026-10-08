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

it('groups projects and sessions under their workspace and opens items with that workspace', async () => {
  vi.spyOn(api, 'sessions').mockResolvedValue({ sessions: [session('b1', '/b', 5)] })
  vi.spyOn(projectApi, 'list').mockResolvedValue({ projects: [] })
  const { props, view } = renderSidebar()

  const groups = view.container.querySelectorAll('.workspace-group')
  expect([...groups].map(group => group.querySelector('.workspace-name')?.textContent)).toEqual(['a', 'b'])
  // Projects come before sessions in the current workspace.
  expect([...groups[0]!.querySelectorAll('.session-title > span:last-child')].map(node => node.textContent))
    .toEqual(['Project p1', 'Session a1', 'Session a2'])

  // Another workspace loads its own sessions; opening one names that workspace.
  await waitFor(() => expect(view.getByText('Session b1')).toBeTruthy())
  expect(api.sessions).toHaveBeenCalledWith('/b')
  fireEvent.click(view.getByText('Session b1'))
  expect(props.onSelectSession).toHaveBeenCalledWith('/b', 'b1')
  fireEvent.click(view.getByText('Project p1'))
  expect(props.onSelectProject).toHaveBeenCalledWith('/a', 'p1')
})

it('remembers collapsed workspaces and keeps archived projects behind "more"', async () => {
  vi.spyOn(api, 'sessions').mockResolvedValue({ sessions: [] })
  vi.spyOn(projectApi, 'list').mockResolvedValue({ projects: [] })
  const { view } = renderSidebar({ projects: [project('live', 2), project('old', 1, true)] })

  expect(view.queryByText('Project old')).toBeNull()
  fireEvent.click(view.getByText('1 more'))
  expect(view.getByText('Project old')).toBeTruthy()

  const toggle = view.getAllByRole('button', { expanded: true }).find(button => button.textContent === 'b')!
  fireEvent.click(toggle)
  expect(JSON.parse(localStorage.getItem('tnega.sidebar.collapsed') ?? '[]')).toEqual(['/b'])
  cleanup()
  const again = renderSidebar().view
  expect(again.getAllByRole('button', { expanded: false }).map(button => button.textContent)).toContain('b')
})
