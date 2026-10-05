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
