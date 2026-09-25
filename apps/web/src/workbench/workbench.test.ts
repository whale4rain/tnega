// @vitest-environment jsdom
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Theme } from '@radix-ui/themes'
import { WorkspaceSidebar } from './WorkspaceSidebar'

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
describe('workbench navigation', () => {
  it('searches sessions, selects a result, and creates coding sessions by default', () => {
    const onSelect = vi.fn(),
      onNew = vi.fn().mockResolvedValue(undefined)
    const action = vi.fn().mockResolvedValue(undefined)
    render(
      createElement(
        Theme,
        {},
        createElement(WorkspaceSidebar, {
          workspaces: ['/project', '/other'],
          workspace: '/project',
          selectedId: 'one',
          theme: 'dark',
        projects: [],
        selectedProjectId: null,
        onOpenProject: () => {},
        onNewProject: () => {},
        onArchiveProject: async () => {},
        onDeleteProject: async () => {},
          sessions: ['Fix parser', 'Add tests'].map((title, index) => ({
            id: String(index),
            title,
            workspace: '/project',
            createdAt: 0,
            updatedAt: 0,
            eventCount: 0,
          })),
          onAdd: action,
          onRemove: action,
          onSelect,
          onNew,
          onRename: action,
          onFork: action,
          onDelete: action,
          onSettings: vi.fn(),
          onTheme: vi.fn(),
        }),
      ),
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Search sessions' }), {
      target: { value: 'parser' },
    })
    expect(screen.queryByRole('button', { name: 'Add tests' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Fix parser' }))
    expect(onSelect).toHaveBeenCalledWith('/project', '0')
    fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(onNew).toHaveBeenCalledWith({ agentType: 'coding' })
  })
  it('renders independent workspace groups instead of a workspace switcher', () => {
    const action = vi.fn().mockResolvedValue(undefined)
    const onNew = vi.fn().mockResolvedValue(undefined)
    render(
      createElement(
        Theme,
        {},
        createElement(WorkspaceSidebar, {
          workspaces: ['/project', '/other'],
          workspace: '/project',
          selectedId: 'same',
          theme: 'dark',
        projects: [],
        selectedProjectId: null,
        onOpenProject: () => {},
        onNewProject: () => {},
        onArchiveProject: async () => {},
        onDeleteProject: async () => {},
          sessions: ['/project', '/other'].map((workspace) => ({
            id: 'same',
            title: `Session in ${workspace}`,
            workspace,
            createdAt: 0,
            updatedAt: 0,
            eventCount: 0,
          })),
          onSelect: vi.fn(),
          onAdd: action,
          onRemove: action,
          onNew,
          onRename: action,
          onFork: action,
          onDelete: action,
          onSettings: vi.fn(),
          onTheme: vi.fn(),
        }),
      ),
    )
    expect(
      screen
        .getByRole('button', { name: 'Session in /other' })
        .getAttribute('aria-current'),
    ).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: 'Toggle children' })[0]!)
    expect(
      screen.queryByRole('button', { name: 'Session in /project' }),
    ).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Session in /other' }),
    ).toBeTruthy()
    fireEvent.click(
      screen.getByRole('button', { name: 'New session in other' }),
    )
    expect(onNew).toHaveBeenCalledWith({ agentType: 'coding' }, '/other')
    fireEvent.change(screen.getByRole('textbox', { name: 'Search sessions' }), {
      target: { value: 'Session in /project' },
    })
    expect(
      screen.getByRole('button', { name: 'Session in /project' }),
    ).toBeTruthy()
    expect(
      screen.queryByRole('button', { name: 'Session in /other' }),
    ).toBeNull()
  })
})
