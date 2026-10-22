// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { FileActionsContext, type FileActions } from '../FileMenu'
import { FilesView } from './FilesView'

beforeEach(() => {
  localStorage.clear()
  vi.spyOn(api, 'fileTree').mockResolvedValue({ path: '', entries: [] })
  vi.spyOn(api, 'readText').mockImplementation(async (_workspace, path) => ({
    path,
    content: path.endsWith('.md') ? '# Release notes\n\nShipped **today**.' : '<h1>Hi</h1>',
    size: 30,
    mtimeMs: 1,
  }))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function files(path: string, actions: FileActions = {}) {
  return render(createElement(FileActionsContext.Provider, { value: actions },
    createElement(FilesView, { workspace: '/repo', focus: { tool: 'files', path, nonce: 1 }, onPreview: vi.fn() })))
}

it('renders a Markdown file and switches to its source', async () => {
  const view = files('docs/notes.md')
  expect((await view.findByRole('heading', { name: 'Release notes' })).tagName).toBe('H1')
  const preview = view.getByRole('radio', { name: 'Preview' })
  expect(preview.getAttribute('aria-checked')).toBe('true')
  fireEvent.click(view.getByRole('radio', { name: 'Source' }))
  expect(view.queryByRole('heading', { name: 'Release notes' })).toBeNull()
  expect(view.getByRole('radio', { name: 'Source' }).getAttribute('aria-checked')).toBe('true')
  // The choice is remembered for the next Markdown file.
  expect(localStorage.getItem('tnega.markdownView')).toContain('source')
})

it('offers to show an HTML file in the browser when there is one', async () => {
  const open = vi.fn()
  const view = files('site/index.html', { workspace: '/repo', open, browser: true })
  fireEvent.click(await view.findByRole('button', { name: 'Open in browser' }))
  expect(open).toHaveBeenCalledWith('site/index.html')
  expect(view.queryByRole('radio', { name: 'Preview' })).toBeNull()
})

it('has no browser button without the Workbench browser', async () => {
  const view = files('site/index.html', { workspace: '/repo', open: vi.fn(), browser: false })
  await view.findByText('site/index.html')
  expect(view.queryByRole('button', { name: 'Open in browser' })).toBeNull()
})
