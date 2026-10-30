// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it } from 'vitest'
import { ApprovalCard } from './Conversation'

afterEach(cleanup)

it('shows the whole shell command and the working directory before approval', () => {
  const command = `echo ${'x'.repeat(2500)}; Remove-Item important.txt`
  const view = render(createElement(ApprovalCard, {
    approval: { id: 'approval', tool: 'shell', input: JSON.stringify({ command, cwd: 'important-folder', timeoutMs: 90000 }) },
    onAnswer: () => {},
  }))
  const text = view.getByRole('alertdialog', { name: 'Permission request' }).textContent
  expect(text).toContain(command)
  expect(text).toContain('important-folder')
  expect(text).toContain('90000')
})

it('says when a CodeMode script made the call', () => {
  const view = render(createElement(ApprovalCard, {
    approval: { id: 'approval', tool: 'shell', input: JSON.stringify({ command: 'npm test' }), via: 'run_code' },
    onAnswer: () => {},
  }))
  expect(view.getByRole('alertdialog').textContent).toContain('wants to use shell from a CodeMode script')
})

it('offers a Session-long grant in words and allows it with one press', () => {
  const answers: boolean[] = []
  const view = render(createElement(ApprovalCard, {
    approval: {
      id: 'approval',
      tool: 'computer_screenshot',
      input: JSON.stringify({ window_id: 7 }),
      grant: { scope: 'computer:app:notepad.exe', label: 'see and use notepad.exe on this computer for the rest of this session' },
    },
    onAnswer: allow => answers.push(allow),
  }))
  expect(view.getByRole('alertdialog').textContent).toContain('The agent wants to see and use notepad.exe on this computer for the rest of this session')
  view.getByRole('button', { name: 'Allow in this session' }).click()
  expect(answers).toEqual([true])
})
