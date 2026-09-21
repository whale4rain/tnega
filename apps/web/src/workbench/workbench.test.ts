// @vitest-environment jsdom
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Theme } from '@radix-ui/themes'
import { WorkbenchShell } from './WorkbenchShell'
import { WorkspaceSidebar } from './WorkspaceSidebar'

beforeEach(() => localStorage.clear())
afterEach(cleanup)
function shell() {
  return render(
    createElement(
      Theme,
      {},
      createElement(WorkbenchShell, {
        sidebar: 'Project navigation',
        children: 'Conversation',
      }),
    ),
  )
}
describe('workbench navigation', () => {
  it('shows the Tnega icon in the application header', () => {
    shell()
    expect(screen.getByRole('img', { name: 'Tnega icon' }).getAttribute('src')).toBe(
      '/tnega-icon.png',
    )
  })
  it('collapses and restores navigation and remembers the choice across mounts', () => {
    const view = shell()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    expect(
      screen.queryByRole('complementary', { name: 'Workspace navigation' }),
    ).toBeNull()
    expect(screen.getByText('Conversation')).toBeTruthy()
    view.unmount()
    shell()
    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }))
    expect(
      screen.getByRole('complementary', { name: 'Workspace navigation' }),
    ).toBeTruthy()
  })
  it('opens one tool panel at a time, labels placeholders, and closes with Escape', () => {
    shell()
    fireEvent.click(screen.getByRole('button', { name: 'Toggle Files' }))
    expect(
      screen.getByRole('complementary', { name: 'Files panel' }),
    ).toBeTruthy()
    expect(screen.getByText('Coming soon')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Toggle Terminal' }))
    expect(
      screen.queryByRole('complementary', { name: 'Files panel' }),
    ).toBeNull()
    expect(
      screen.getByRole('complementary', { name: 'Terminal panel' }),
    ).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(
      screen.queryByRole('complementary', { name: 'Terminal panel' }),
    ).toBeNull()
  })
  it('searches sessions, selects a result, and creates coding sessions by default', () => {
    const onSelect = vi.fn(),
      onNew = vi.fn().mockResolvedValue(undefined)
    const action = vi.fn().mockResolvedValue(undefined)
    render(
      createElement(
        Theme,
        {},
        createElement(WorkspaceSidebar, {
          workspaces: ['/project'],
          workspace: '/project',
          selectedId: 'one',
          theme: 'dark',
          sessions: ['Fix parser', 'Add tests'].map((title, index) => ({
            id: String(index),
            title,
            workspace: '/project',
            createdAt: 0,
            updatedAt: 0,
            eventCount: 0,
          })),
          onWorkspace: vi.fn(),
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
    expect(onSelect).toHaveBeenCalledWith('0')
    fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(onNew).toHaveBeenCalledWith({ agentType: 'coding' })
  })
})
