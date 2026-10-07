// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { LinkContext } from '../lib/links'
import { Markdown } from './Markdown'

afterEach(cleanup)

it('opens bare and absolute file references while leaving code blocks and existing links intact', () => {
  const openPath = vi.fn()
  const view = render(createElement(LinkContext.Provider, { value: { workspace: '/repo', openPath } }, createElement(Markdown, {
    text: 'Changed src/app.ts:42，see /repo/docs/brief.md. Also `/repo/docs/brief.md` and [brief](docs/brief.md).\n\n```\nsrc/app.ts\n```',
  })))
  fireEvent.click(view.getByText('src/app.ts:42'))
  fireEvent.click(view.getAllByText('/repo/docs/brief.md')[0]!)
  fireEvent.click(view.getAllByText('/repo/docs/brief.md')[1]!)
  fireEvent.click(view.getByText('brief'))
  expect(openPath.mock.calls).toEqual([['src/app.ts'], ['docs/brief.md'], ['docs/brief.md'], ['docs/brief.md']])
  expect(view.container.querySelectorAll('a a')).toHaveLength(0)
  expect(view.container.querySelector('.code-block a')).toBeNull()
})

const text = 'See [the app](src/App.tsx:12), `apps/web/src/main.tsx`, [the server](http://localhost:5173/) and [docs](https://example.com).'

it('opens file links and file-like inline code in the Workbench and dev servers in the app browser', () => {
  const openPath = vi.fn()
  const openLocalUrl = vi.fn()
  const view = render(createElement(LinkContext.Provider, { value: { workspace: '/repo', openPath, openLocalUrl } }, createElement(Markdown, { text })))
  fireEvent.click(view.getByText('the app'))
  fireEvent.click(view.getByText('apps/web/src/main.tsx'))
  expect(openPath.mock.calls).toEqual([['src/App.tsx'], ['apps/web/src/main.tsx']])
  fireEvent.click(view.getByText('the server'))
  expect(openLocalUrl).toHaveBeenCalledWith('http://localhost:5173/')
  expect(view.getByText('docs').closest('a')?.getAttribute('target')).toBe('_blank')
})

it('does not turn file links into broken navigation where nothing can open them', () => {
  const view = render(createElement(Markdown, { text }))
  expect(view.getByText('the app').closest('a')).toBeNull()
  expect(view.getByText('apps/web/src/main.tsx').closest('a')).toBeNull()
  expect(view.getByText('the server').closest('a')?.getAttribute('target')).toBe('_blank')
})

it('leaves fenced code blocks alone', () => {
  const view = render(createElement(LinkContext.Provider, { value: { openPath: vi.fn() } }, createElement(Markdown, { text: '```\nsrc/App.tsx\n```' })))
  expect(view.container.querySelector('.code-block pre code')?.textContent).toBe('src/App.tsx')
  expect(view.container.querySelector('.code-link')).toBeNull()
})

it('keeps path:line links that the default sanitizer drops, and still drops script links', () => {
  const openPath = vi.fn()
  const view = render(createElement(LinkContext.Provider, { value: { openPath } }, createElement(Markdown, { text: '[a](server.cjs:2) [b](javascript:alert(1))' })))
  fireEvent.click(view.getByText('a'))
  expect(openPath).toHaveBeenCalledWith('server.cjs')
  expect(view.getByText('b').closest('a')?.getAttribute('href') ?? '').not.toContain('javascript')
})
