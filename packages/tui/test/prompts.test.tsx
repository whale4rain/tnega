import { stripVTControlCharacters } from 'node:util'
import type { QuestionAnswerItem } from '@tnega/client'
import { render } from 'ink-testing-library'
import { afterEach, expect, it } from 'vitest'
import { SecretStep } from '../src/prompts.js'

let unmount: (() => void) | undefined
afterEach(() => { unmount?.() })

const pause = () => new Promise(resolve => setTimeout(resolve, 20))

it('takes a secret on a masked line and sends Remember only when toggled', async () => {
  const answers: Array<QuestionAnswerItem | undefined> = []
  const app = render(<SecretStep question={{ id: 'token', question: 'GitHub token', secret: 'GITHUB_TOKEN' }} name="GITHUB_TOKEN" onDone={answer => answers.push(answer)} />)
  unmount = app.unmount
  await pause()
  app.stdin.write('ghp_secret')
  await pause()
  const frame = stripVTControlCharacters(app.lastFrame() ?? '')
  expect(frame).not.toContain('ghp_secret')
  expect(frame).toContain('••••••••••')
  expect(frame).toContain('$GITHUB_TOKEN')
  expect(frame).toContain('[ ] this session only')
  app.stdin.write('\t')
  await pause()
  expect(stripVTControlCharacters(app.lastFrame() ?? '')).toContain('[x] remember for this workspace')
  app.stdin.write('\r')
  await pause()
  expect(answers).toEqual([{ questionId: 'token', text: 'ghp_secret', remember: true }])
})
