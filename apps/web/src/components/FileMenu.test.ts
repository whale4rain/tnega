// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { LinkContext } from '../lib/links'
import { FileActionsContext, type FileActions } from './FileMenu'
import { Markdown } from './Markdown'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(globalThis, 'tnegaDesktop')
})

function reply(text: string, actions: FileActions) {
  const openPath = actions.open ?? vi.fn()
  return render(createElement(FileActionsContext.Provider, { value: actions },
    createElement(LinkContext.Provider, { value: { workspace: '/repo', openPath } }, createElement(Markdown, { text }))))
}

function menuLabels(view: ReturnType<typeof render>): string[] {
  return view.getAllByRole('menuitem').map(item => item.textContent ?? '')
}

it('offers to show an HTML file in the browser or edit its source', () => {
  const open = vi.fn()
  const edit = vi.fn()
  const view = reply('Built [the page](site/index.html).', { workspace: '/repo', open, edit, browser: true })
  fireEvent.contextMenu(view.getByText('the page'), { clientX: 40, clientY: 40 })
  expect(menuLabels(view)).toEqual(['Open in browser', 'Edit in Files', 'Copy path', 'Copy relative path'])
  fireEvent.click(view.getByRole('menuitem', { name: 'Edit in Files' }))
  expect(edit).toHaveBeenCalledWith('site/index.html')
  expect(view.queryByRole('menu')).toBeNull()
})

it('opens Markdown as a preview and keeps HTML in Files without a browser', () => {
  const view = reply('See [notes](docs/notes.md) and [page](a.html).', { workspace: '/repo', open: vi.fn(), edit: vi.fn(), browser: false })
  fireEvent.contextMenu(view.getByText('notes'), { clientX: 10, clientY: 10 })
  expect(menuLabels(view).slice(0, 2)).toEqual(['Open preview', 'Edit in Files'])
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(view.queryByRole('menu')).toBeNull()
  fireEvent.contextMenu(view.getByText('page'), { clientX: 10, clientY: 10 })
  expect(menuLabels(view)[0]).toBe('Open in Files')
  expect(menuLabels(view)).not.toContain('Edit in Files')
})

it('copies the absolute and the workspace-relative path', async () => {
  const writeText = vi.fn(async () => undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  const view = reply('See [app](src/app.ts).', { workspace: '/repo', open: vi.fn() })
  fireEvent.contextMenu(view.getByText('app'), { clientX: 10, clientY: 10 })
  fireEvent.click(view.getByRole('menuitem', { name: 'Copy path' }))
  fireEvent.contextMenu(view.getByText('app'), { clientX: 10, clientY: 10 })
  fireEvent.click(view.getByRole('menuitem', { name: 'Copy relative path' }))
  expect(writeText.mock.calls).toEqual([['/repo/src/app.ts'], ['src/app.ts']])
})

it('hands the file to the system app in the desktop app', async () => {
  const open = vi.fn(async () => 'opened')
  const reveal = vi.fn(async () => 'revealed')
  Reflect.set(globalThis, 'tnegaDesktop', { platform: 'darwin', files: { open, reveal } })
  const view = reply('See [app](src/app.ts).', { workspace: '/repo', open: vi.fn() })
  fireEvent.contextMenu(view.getByText('app'), { clientX: 10, clientY: 10 })
  expect(menuLabels(view)).toContain('Show in Finder')
  fireEvent.click(view.getByRole('menuitem', { name: 'Open with default app' }))
  await waitFor(() => expect(open).toHaveBeenCalledWith('/repo', 'src/app.ts'))
  fireEvent.contextMenu(view.getByText('app'), { clientX: 10, clientY: 10 })
  fireEvent.click(view.getByRole('menuitem', { name: 'Show in Finder' }))
  await waitFor(() => expect(reveal).toHaveBeenCalledWith('/repo', 'src/app.ts'))
})

it('moves through the items with the arrow keys', () => {
  const view = reply('See [app](src/app.ts).', { workspace: '/repo', open: vi.fn() })
  fireEvent.contextMenu(view.getByText('app'), { clientX: 10, clientY: 10 })
  const items = view.getAllByRole('menuitem')
  expect(document.activeElement).toBe(items[0])
  fireEvent.keyDown(view.getByRole('menu'), { key: 'ArrowDown' })
  expect(document.activeElement).toBe(items[1])
  fireEvent.keyDown(view.getByRole('menu'), { key: 'ArrowUp' })
  fireEvent.keyDown(view.getByRole('menu'), { key: 'ArrowUp' })
  expect(document.activeElement).toBe(items.at(-1))
})
