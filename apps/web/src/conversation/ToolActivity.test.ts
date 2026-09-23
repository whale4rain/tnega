// @vitest-environment jsdom
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { ToolBlock, ToolGroupBlock } from './ToolActivity'
import type { DisplayMessage } from '../types'

afterEach(cleanup)
const read: DisplayMessage = {
  id: 'read',
  role: 'tool',
  content: '',
  tool: {
    name: 'read_file',
    callId: 'call-read',
    argumentsText: '{"path":"src/main.ts"}',
    status: 'done',
    ok: true,
    outputText: 'file contents',
  },
}

it('shows a path summary and expands input/output without exposing details initially', () => {
  const { container } = render(createElement(ToolBlock, { message: read }))
  const details = container.querySelector('details')
  expect(details?.open).toBe(false)
  expect(screen.getByText('src/main.ts')).toBeTruthy()
  fireEvent.click(screen.getByText('Read file'))
  expect(details?.open).toBe(true)
  expect(screen.getByText('Input')).toBeTruthy()
  expect(screen.getByText('file contents')).toBeTruthy()
})

it('updates a running tool to failure and preserves its error output', () => {
  const pending: DisplayMessage = {
    ...read,
    tool: { ...read.tool!, status: 'pending', argumentsText: '{' },
  }
  const view = render(createElement(ToolBlock, { message: pending }))
  expect(screen.getByText('Running')).toBeTruthy()
  view.rerender(
    createElement(ToolBlock, {
      message: {
        ...read,
        tool: { ...read.tool!, ok: false, errorText: 'Permission denied' },
      },
    }),
  )
  expect(screen.queryByText('Running')).toBeNull()
  expect(screen.getByText('Failed')).toBeTruthy()
  fireEvent.click(screen.getByText('Read file'))
  expect(screen.getByText('Permission denied')).toBeTruthy()
})

it('groups multiple calls but keeps a single call one click away', () => {
  const view = render(createElement(ToolGroupBlock, { tools: [read] }))
  expect(view.container.querySelectorAll('details')).toHaveLength(1)
  view.rerender(
    createElement(ToolGroupBlock, {
      tools: [read, { ...read, id: 'read-two' }],
    }),
  )
  expect(screen.getByText('2')).toBeTruthy()
  expect(view.container.querySelectorAll('details')).toHaveLength(3)
})

it('bounds a huge output and offers the rest behind a click', () => {
  const huge: DisplayMessage = {
    ...read,
    tool: { ...read.tool!, outputText: 'y'.repeat(12_000) },
  }
  const view = render(createElement(ToolBlock, { message: huge }))
  fireEvent.click(screen.getByText('Read file'))

  const pre = view.container.querySelector('.tool-output')!
  expect(pre.textContent!.length).toBeLessThan(6_000)
  fireEvent.click(screen.getByText('[show all 12,000 characters]'))
  expect(view.container.querySelector('.tool-output')!.textContent)
    .toHaveLength(12_000)
  fireEvent.click(screen.getByText('[show less]'))
  expect(view.container.querySelector('.tool-output')!.textContent!.length)
    .toBeLessThan(6_000)
})

it('surfaces a spill notice as the pointer to the stored result', () => {
  // Byte-identical to what @tnega/tool-spill writes.
  const spilled: DisplayMessage = {
    ...read,
    tool: {
      ...read.tool!,
      outputText:
        'preview head\n…\npreview tail'
        + '\n\n(Omitted 14129 bytes. Full formatted result stored at: '
        + '.tnega/spill/shell-call_1-shell.txt. Read it with the read_file tool'
        + ' (raise maxBytes or use offset/limit for a specific window), '
        + 'or grep this path to search inside it.)',
    },
  }
  const view = render(createElement(ToolBlock, { message: spilled }))
  fireEvent.click(screen.getByText('Read file'))

  const pre = view.container.querySelector('.tool-output')!
  expect(pre.textContent).toBe('preview head\n…\npreview tail')
  expect(screen.getByText('.tnega/spill/shell-call_1-shell.txt')).toBeTruthy()
  expect(view.container.querySelector('.tool-spill')!.textContent)
    .toContain('14,129 bytes omitted')
})
