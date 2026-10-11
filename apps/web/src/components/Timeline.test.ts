// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Block, Entry, ToolView } from '../lib/timeline'
import { applyStream, beginRun } from '../lib/timeline'
import { Timeline } from './Timeline'
import { LinkContext } from '../lib/links'

afterEach(cleanup)

it('opens file and website references in ordinary user messages', () => {
  const openPath = vi.fn()
  const entries: Entry[] = [{ kind: 'user', id: 'user', text: 'Check docs/brief.md and https://example.com.' }]
  const view = render(createElement(LinkContext.Provider, { value: { workspace: '/repo', openPath } },
    createElement(Timeline, { entries, running: false, actions: {} })))
  fireEvent.click(view.getByRole('link', { name: 'docs/brief.md' }))
  expect(openPath).toHaveBeenCalledWith('docs/brief.md')
  expect(view.getByRole('link', { name: 'https://example.com' }).getAttribute('target')).toBe('_blank')
})

it('displays a live compaction message with an expandable summary while the Agent Run continues', () => {
  const entries = applyStream(beginRun([], 'Continue', 1), {
    type: 'session/compaction', id: 'checkpoint', summary: 'The earlier investigation is complete.', tokensBefore: 12000,
  })
  const view = render(createElement(Timeline, { entries, running: true, actions: {} }))
  const marker = view.getByRole('button', { name: 'Context compacted · 12k tokens summarized' })
  expect(view.queryByText('The earlier investigation is complete.')).toBeNull()
  fireEvent.click(marker)
  expect(view.getByText('The earlier investigation is complete.')).toBeTruthy()
  expect(view.queryByRole('button', { name: /Show details|Used/ })).toBeNull()
})

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
  const toggle = view.getByRole('button', { name: 'Show details' })
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(view.getByText('Investigating the problem.')).toBeTruthy()
})

it('keeps the narration in view while the turn runs and folds it once the turn ends', () => {
  const view = render(createElement(Timeline, { entries: [completed], running: true, actions: {} }))
  expect(view.getByText('Investigating the problem.')).toBeTruthy()
  expect(view.getByText('A retry was required.')).toBeTruthy()
  expect(view.queryByRole('button', { name: /Show details|^Working/ })).toBeNull()
  view.rerender(createElement(Timeline, { entries: [completed], running: false, actions: {} }))
  expect(view.queryByText('Investigating the problem.')).toBeNull()
  expect(view.getByRole('button', { name: 'Show details' }).getAttribute('aria-expanded')).toBe('false')
})

it('reveals PTC child tools and their errors inside the outer tool details', () => {
  const entry: Entry = { kind: 'agent', id: 'ptc', status: 'done', blocks: [{
    kind: 'tool', id: 'outer', tool: {
      callId: 'outer', name: 'run_code', args: { code: 'await tools.shell({command:"cargo test"})' }, status: 'error',
      children: [{ callId: 'child', name: 'shell', args: { command: 'cargo test' }, status: 'error', error: 'Tests failed' }],
    },
  }] }
  const view = render(createElement(Timeline, { entries: [entry], running: false, actions: {} }))
  // An ordinary failure is the agent's to handle: it folds with the rest of the process.
  expect(view.queryByText('1 tool call · 1 done')).toBeNull()
  fireEvent.click(view.getByRole('button', { name: /^Used 1 tool/ }))
  expect(view.getByText('1 tool call · 1 done')).toBeTruthy()
  expect(view.queryByText('Tests failed')).toBeNull()
  fireEvent.click(view.getByRole('button', { name: /CodeMode/ }))
  fireEvent.click(view.getByRole('button', { name: /Ran.*cargo test/ }))
  expect(view.getByText('Tests failed')).toBeTruthy()
  expect(view.getByText('Returned to the agent')).toBeTruthy()
  expect(view.container.querySelectorAll('.ptc-tool-children .tool-row')).toHaveLength(1)
})

it('keeps model-facing tool errors quiet and flags only failures a person must act on', () => {
  const tool = (callId: string, extra: Partial<ToolView>): Block => ({
    kind: 'tool', id: callId, tool: { callId, name: 'http_get', args: { url: `https://example.com/${callId}` }, status: 'error', ...extra },
  })
  const entry: Entry = { kind: 'agent', id: 'errors', status: 'done', blocks: [
    tool('missing', { error: 'HTTP 404 Not Found', errorName: 'Error' }),
    tool('denied', { error: 'network access is not allowed', errorName: 'ToolAuthorizationError' }),
  ] }
  const view = render(createElement(Timeline, { entries: [entry], running: false, actions: {} }))
  // The failure a person must act on stays in view; the agent's own error folds away.
  expect(view.getByRole('button', { name: /denied, Failed/ })).toBeTruthy()
  expect(view.queryByRole('button', { name: /missing, Returned an error to the agent/ })).toBeNull()
  fireEvent.click(view.getByRole('button', { name: /^Used 1 tool/ }))
  expect(view.getByRole('button', { name: /missing, Returned an error to the agent/ })).toBeTruthy()
  expect(view.container.querySelectorAll('.tool-row.status-error')).toHaveLength(1)
  expect(view.container.querySelectorAll('.tool-row.status-note')).toHaveLength(1)
})

it('folds tool calls behind one line that names the current step while a turn streams', () => {
  const block = (callId: string, status: ToolView['status']): Block => ({
    kind: 'tool', id: callId, tool: { callId, name: 'read_file', args: { path: `${callId}.ts` }, status },
  })
  const say: Block = { kind: 'text', id: 'say', text: 'Reading the sources first.' }
  const live: Entry = { kind: 'agent', id: 'live', status: 'running', blocks: [say, block('a', 'ok'), block('b', 'ok')] }
  const view = render(createElement(Timeline, { entries: [live], running: true, actions: {} }))
  expect(view.getByText('Reading the sources first.')).toBeTruthy()
  expect(view.queryByRole('button', { name: /Read a.ts/ })).toBeNull()
  expect(view.getByRole('button', { name: /^Used 2 steps/ }).getAttribute('aria-expanded')).toBe('false')
  view.rerender(createElement(Timeline, { entries: [{ ...live, blocks: [...live.blocks, block('c', 'running')] }], running: true, actions: {} }))
  expect(view.getByRole('button', { name: /^Reading c.ts\s*3 steps/ })).toBeTruthy()
  expect(view.container.querySelectorAll('.tool-row')).toHaveLength(0)
  fireEvent.click(view.getByRole('button', { name: /^Reading c.ts/ }))
  expect(view.container.querySelectorAll('.tool-row')).toHaveLength(3)
  const answer: Block = { kind: 'text', id: 'answer', text: 'All three files agree.' }
  view.rerender(createElement(Timeline, { entries: [{ ...live, status: 'done', blocks: [...live.blocks, block('c', 'ok'), answer] }], running: false, actions: {} }))
  expect(view.getByRole('button', { name: 'Used 3 tools: 3 reads' }).getAttribute('aria-expanded')).toBe('false')
  expect(view.queryByText('Reading the sources first.')).toBeNull()
  expect(view.getByText('All three files agree.')).toBeTruthy()
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
  expect(view.getByRole('button', { name: /^CodeMode/ }).getAttribute('aria-expanded')).toBe('true')
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
  fireEvent.click(view.getByRole('button', { name: /^Used 1 tool/ }))
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

it('offers a visible fork from each finished reply, keyed to its assistant message', () => {
  const onFork = vi.fn()
  const reply = (id: string, forkId: string): Entry => ({ kind: 'agent', id, status: 'done', forkId, blocks: [{ kind: 'text', id: forkId, text: `reply ${id}` }] })
  const view = render(createElement(Timeline, { entries: [reply('one', 'm1'), reply('two', 'm2')], running: false, actions: { onFork } }))
  const forks = view.getAllByRole('button', { name: 'Fork from here' })
  expect(forks).toHaveLength(2)
  expect(view.container.querySelectorAll('.agent-turn.is-latest')).toHaveLength(1)
  fireEvent.click(forks[0]!)
  expect(onFork).toHaveBeenCalledWith('m1')
})

it('streams the thought while the model reasons and folds it once the answer starts', () => {
  const thinking = [
    { type: 'message_start', id: 'm1' },
    { type: 'reasoning_delta', id: 'm1', delta: 'Weighing the two options.' },
  ].reduce(applyStream, beginRun([], 'Which one?', 1))
  const view = render(createElement(Timeline, { entries: thinking, running: true, actions: {} }))
  const head = view.getByRole('button', { name: 'Thinking' })
  expect(head.getAttribute('aria-expanded')).toBe('true')
  expect(view.getByText('Weighing the two options.')).toBeTruthy()

  const answered = applyStream(thinking, { type: 'message_delta', id: 'm1', delta: 'Take the first.' })
  view.rerender(createElement(Timeline, { entries: answered, running: true, actions: {} }))
  const folded = view.getByRole('button', { name: /^Thought/ })
  expect(folded.getAttribute('aria-expanded')).toBe('false')
  expect(view.queryByText('Weighing the two options.')).toBeNull()
  fireEvent.click(folded)
  expect(view.getByText('Weighing the two options.')).toBeTruthy()
})

it('labels a finished thought with how long it took', () => {
  const entry: Entry = {
    kind: 'agent', id: 'agent-t', turn: 1, status: 'done',
    summary: { text: 'Take the first.', sourceMessageId: 'answer' },
    blocks: [
      { kind: 'reasoning', id: 'reasoning-answer', text: 'Weighing the two options.', durationMs: 8000 },
      { kind: 'text', id: 'answer', text: 'Take the first.' },
    ],
  }
  const view = render(createElement(Timeline, { entries: [entry], running: false, actions: {} }))
  expect(view.getByRole('button', { name: 'Thought for 8.0s' }).getAttribute('aria-expanded')).toBe('false')
  expect(view.queryByRole('button', { name: /Show details|Used/ })).toBeNull()
})
