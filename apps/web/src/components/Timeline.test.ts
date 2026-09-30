// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it } from 'vitest'
import type { Entry } from '../lib/timeline'
import { Timeline } from './Timeline'

afterEach(cleanup)

const completed: Entry = {
  kind: 'agent', id: 'agent-1', turn: 1, status: 'done',
  summary: { text: 'Finished the work.', sourceMessageId: 'answer' },
  blocks: [
    { kind: 'text', id: 'process', text: 'Investigating the problem.' },
    { kind: 'text', id: 'answer', text: 'Finished the work.' },
    { kind: 'notice', id: 'notice', tone: 'warn', text: 'A retry was required.' },
    { kind: 'files', id: 'files', files: [{ path: 'src/main.ts', additions: 2 }] },
  ],
}

it('shows final reply and files by default and reveals completed process on demand', () => {
  const view = render(createElement(Timeline, { entries: [completed], running: false, actions: {} }))
  expect(view.getByText('Finished the work.')).toBeTruthy()
  expect(view.getByText('src/main.ts')).toBeTruthy()
  expect(view.getByText('A retry was required.')).toBeTruthy()
  expect(view.queryByText('Investigating the problem.')).toBeNull()
  const toggle = view.getByRole('button', { name: 'Completed process' })
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(view.getByText('Investigating the problem.')).toBeTruthy()
})

it('keeps process fully visible while streaming', () => {
  const view = render(createElement(Timeline, { entries: [completed], running: true, actions: {} }))
  expect(view.getByText('Investigating the problem.')).toBeTruthy()
  expect(view.queryByRole('button', { name: 'Completed process' })).toBeNull()
})

it('reveals PTC child tools and their errors inside the outer tool details', () => {
  const entry: Entry = { kind: 'agent', id: 'ptc', status: 'done', blocks: [{
    kind: 'tool', id: 'outer', tool: {
      callId: 'outer', name: 'run_code', args: { code: 'await tools.shell({command:"cargo test"})' }, status: 'error',
      children: [{ callId: 'child', name: 'shell', args: { command: 'cargo test' }, status: 'error', error: 'Tests failed' }],
    },
  }] }
  const view = render(createElement(Timeline, { entries: [entry], running: false, actions: {} }))
  expect(view.getByText('1 tool call · 0 done · 1 failed')).toBeTruthy()
  expect(view.queryByText('Tests failed')).toBeNull()
  fireEvent.click(view.getByRole('button', { name: /CodeMode/ }))
  fireEvent.click(view.getByRole('button', { name: /Ran.*cargo test/ }))
  expect(view.getByText('Tests failed')).toBeTruthy()
  expect(view.container.querySelectorAll('.ptc-tool-children .tool-row')).toHaveLength(1)
})

it('opens running CodeMode scripts and child tool progress without showing escaped JSON', () => {
  const code = 'const result = await tools.read_file({path: "README.md"});\ntext(result);'
  const entry: Entry = { kind: 'agent', id: 'ptc-live', status: 'running', blocks: [{
    kind: 'tool', id: 'outer', tool: {
      callId: 'outer', name: 'run_code', args: { code }, status: 'running',
      children: [
        { callId: 'read', name: 'read_file', args: { path: 'README.md' }, status: 'ok' },
        { callId: 'search', name: 'grep', args: { pattern: 'TODO' }, status: 'running' },
      ],
    },
  }] }
  const view = render(createElement(Timeline, { entries: [entry], running: true, actions: {} }))
  expect(view.getByRole('button', { name: /CodeMode/ }).getAttribute('aria-expanded')).toBe('true')
  expect(view.container.querySelector('.code-block pre code')?.textContent).toBe(code)
  expect(view.getByText('javascript')).toBeTruthy()
  expect(view.container.querySelector('.code-token-keyword')?.textContent).toBe('const')
  expect(view.getByText('2 tool calls · 1 done · 1 running')).toBeTruthy()
  expect(view.getByRole('button', { name: /Read README.md/ })).toBeTruthy()
  expect(view.getByRole('button', { name: /Searching TODO/ })).toBeTruthy()
})

it('renders text emissions as separate readable blocks and a returned value separately', () => {
  const entry: Entry = { kind: 'agent', id: 'ptc-output', status: 'done', blocks: [{
    kind: 'tool', id: 'outer', tool: {
      callId: 'outer', name: 'run_code', args: { code: 'text("one");\nreturn 42;' }, status: 'ok',
      output: { ok: true, output: ['first line\nsecond line', '<script>literal text</script>'], value: 42 },
    },
  }] }
  const view = render(createElement(Timeline, { entries: [entry], running: false, actions: {} }))
  fireEvent.click(view.getByRole('button', { name: /CodeMode/ }))
  expect([...view.container.querySelectorAll('.ptc-output-block')].map(block => block.textContent)).toEqual(['first line\nsecond line', '<script>literal text</script>'])
  expect(view.getByText('Return value')).toBeTruthy()
  expect(view.getByText('42', { selector: 'pre.tool-output' })).toBeTruthy()
  expect(view.container.querySelector('script')).toBeNull()
})

it('shows office files a finished turn produced and opens them on click', () => {
  const entry: Entry = {
    kind: 'agent', id: 'agent-office', turn: 1, status: 'done',
    summary: { text: 'Saved the workbook.', sourceMessageId: 'answer' },
    blocks: [
      { kind: 'tool', id: 't1', tool: { callId: 't1', name: 'office_create', args: { path: 'out/sales.xlsx' }, status: 'ok', output: { path: 'out/sales.xlsx', kind: 'xlsx' } } },
      { kind: 'text', id: 'answer', text: 'Saved the workbook.' },
    ],
  }
  const opened: string[] = []
  const view = render(createElement(Timeline, { entries: [entry], running: false, actions: { onOpenFile: path => opened.push(path) } }))
  fireEvent.click(view.getByRole('button', { name: /sales\.xlsx/ }))
  expect(opened).toEqual(['out/sales.xlsx'])

  cleanup()
  const live = render(createElement(Timeline, { entries: [entry], running: true, actions: {} }))
  expect(live.queryByTitle('Preview out/sales.xlsx')).toBeNull()
})
