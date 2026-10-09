// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { CLIENT_COMMANDS } from '../lib/completion'
import { PromptBox } from './PromptBox'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function messageBox(view: { getByRole: (role: string, options: { name: string }) => HTMLElement }): HTMLTextAreaElement {
  const box = view.getByRole('textbox', { name: 'Message' })
  if (!(box instanceof HTMLTextAreaElement)) throw new Error('message box is not a textarea')
  return box
}

function type(textarea: HTMLTextAreaElement, value: string): void {
  fireEvent.change(textarea, { target: { value, selectionStart: value.length } })
  textarea.setSelectionRange(value.length, value.length)
  fireEvent.select(textarea)
}

it('completes commands, closes on Escape, reopens on typing and runs a typed-out command on Enter', () => {
  const onSubmit = vi.fn(() => true)
  const view = render(createElement(PromptBox, { commands: CLIENT_COMMANDS, onSubmit, placeholder: 'Reply…' }))
  const box = messageBox(view)
  type(box, '/')
  expect(view.getAllByRole('option')).toHaveLength(CLIENT_COMMANDS.length)
  fireEvent.keyDown(box, { key: 'Escape' })
  expect(view.queryByRole('listbox')).toBeNull()
  type(box, '/pl')
  expect(view.getByRole('option', { name: /\/plan/ })).toBeTruthy()
  fireEvent.keyDown(box, { key: 'Enter' })
  expect(box.value).toBe('/plan ')
  expect(onSubmit).not.toHaveBeenCalled()
  fireEvent.keyDown(box, { key: 'Enter' })
  expect(onSubmit).toHaveBeenCalledWith('/plan', [])
})

it('inserts @ file mentions from the workspace search', async () => {
  vi.useFakeTimers()
  const searchFiles = vi.fn(async () => ['outputs/q2-summary.xlsx', 'notes.md'])
  const view = render(createElement(PromptBox, { searchFiles, onSubmit: () => true, placeholder: 'Reply…' }))
  const box = messageBox(view)
  type(box, 'compare @q2')
  await act(async () => { await vi.advanceTimersByTimeAsync(200) })
  expect(searchFiles).toHaveBeenCalledWith('q2')
  expect(view.getByRole('listbox', { name: 'Workspace files' })).toBeTruthy()
  fireEvent.keyDown(box, { key: 'Tab' })
  expect(box.value).toBe('compare @outputs/q2-summary.xlsx ')
})

it('completes command arguments through the given source', async () => {
  const completeArgument = vi.fn(async () => [{ value: 'gpt-x', label: 'GPT X', detail: 'gpt-x' }])
  const view = render(createElement(PromptBox, { commands: CLIENT_COMMANDS, completeArgument, onSubmit: () => true, placeholder: 'Reply…' }))
  const box = messageBox(view)
  type(box, '/model g')
  expect(await view.findByRole('option', { name: /GPT X/ })).toBeTruthy()
  expect(completeArgument).toHaveBeenCalledWith('/model', 'g')
  fireEvent.keyDown(box, { key: 'Enter' })
  expect(box.value).toBe('/model gpt-x ')
})

it('allows asynchronous messages, interruption and independent stop while running', async () => {
  const onSubmit = vi.fn(() => true)
  const onInterruptSubmit = vi.fn(() => true)
  const onStop = vi.fn()
  const view = render(createElement(PromptBox, {
    running: true, allowWhileRunning: true, onSubmit, onInterruptSubmit, onStop, placeholder: 'Reply…',
  }))
  const box = messageBox(view)
  type(box, 'Keep investigating')
  await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }) })
  expect(onSubmit).toHaveBeenCalledWith('Keep investigating', [])
  expect(onInterruptSubmit).not.toHaveBeenCalled()
  expect(box.value).toBe('')
  type(box, 'Change direction now')
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Interrupt and send' })) })
  expect(onInterruptSubmit).toHaveBeenCalledWith('Change direction now', [])
  expect(box.value).toBe('')
  fireEvent.click(view.getByRole('button', { name: 'Stop' }))
  fireEvent.keyDown(box, { key: 'Escape' })
  expect(onStop).toHaveBeenCalledTimes(2)
})

it('keeps the session stop-only behavior unless sending while running is enabled', async () => {
  const onSubmit = vi.fn(() => true)
  const onStop = vi.fn()
  const view = render(createElement(PromptBox, { running: true, onSubmit, onStop, placeholder: 'Reply…' }))
  type(messageBox(view), 'Later')
  await act(async () => { fireEvent.keyDown(messageBox(view), { key: 'Enter' }) })
  expect(onSubmit).not.toHaveBeenCalled()
  expect(view.queryByRole('button', { name: 'Send' })).toBeNull()
  fireEvent.click(view.getByRole('button', { name: 'Stop' }))
  expect(onStop).toHaveBeenCalledOnce()
})

it('shows send, not stop, in an empty single-control box while nothing runs', () => {
  const props = { allowWhileRunning: true, inline: true, onSubmit: vi.fn(() => true), onStop: vi.fn(), placeholder: 'Message…' }
  const idle = render(createElement(PromptBox, { ...props, running: false }))
  expect(idle.queryByRole('button', { name: 'Stop' })).toBeNull()
  expect((idle.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
  idle.unmount()
  const busy = render(createElement(PromptBox, { ...props, running: true }))
  expect(busy.getByRole('button', { name: 'Stop' })).toBeTruthy()
  expect(busy.queryByRole('button', { name: 'Send' })).toBeNull()
  type(messageBox(busy), 'More context')
  expect(busy.queryByRole('button', { name: 'Stop' })).toBeNull()
  expect(busy.getByRole('button', { name: 'Send' })).toBeTruthy()
})
