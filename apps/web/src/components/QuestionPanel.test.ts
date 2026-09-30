// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import type { PendingQuestionRequest } from '../lib/types'
import { QuestionCard, QuestionPanel } from './QuestionPanel'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
const request: PendingQuestionRequest = {
  requestId: 'request', agentId: 'agent', mode: 'blocking', createdAt: 1, status: 'pending',
  questions: [
    { id: 'direction', question: '选择方向', options: [{ label: 'A', description: '第一种方案' }, { label: 'B' }] },
    { id: 'extra', question: '', optional: true },
  ],
}

it('requires an explicit answer, keeps free text for every question, and permits skipping optional questions', async () => {
  const onAnswer = vi.fn().mockResolvedValue(undefined)
  const view = render(createElement(QuestionCard, { request, onAnswer }))
  const submit = view.getByRole('button', { name: '提交回答' })
  expect(submit.hasAttribute('disabled')).toBe(true)
  expect(view.getAllByRole('textbox')).toHaveLength(2)
  expect(view.getByText('你的意见')).toBeTruthy()
  fireEvent.click(view.getByRole('radio', { name: 'A 第一种方案' }))
  fireEvent.change(view.getByRole('textbox', { name: '选择方向：补充或自定义回答' }), { target: { value: '  更喜欢这个  ' } })
  fireEvent.click(submit)
  await waitFor(() => expect(onAnswer).toHaveBeenCalledWith([{ questionId: 'direction', selected: ['A'], text: '更喜欢这个' }]))
})

it('blocks duplicate submissions and shows server errors without losing the draft', async () => {
  let reject: ((error: Error) => void) | undefined
  const onAnswer = vi.fn(() => new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise }))
  const view = render(createElement(QuestionCard, { request, onAnswer }))
  fireEvent.change(view.getByRole('textbox', { name: '选择方向：补充或自定义回答' }), { target: { value: '自己的方案' } })
  fireEvent.click(view.getByRole('button', { name: '提交回答' }))
  fireEvent.submit(view.getByRole('form', { name: '会话问题' }))
  expect(onAnswer).toHaveBeenCalledTimes(1)
  reject?.(new Error('回答格式不正确'))
  expect(await view.findByRole('alert')).toHaveProperty('textContent', '回答格式不正确')
  expect(view.getByRole('textbox', { name: '选择方向：补充或自定义回答' })).toHaveProperty('value', '自己的方案')
})

it('allows explicitly skipping a request whose questions are all optional', async () => {
  const onAnswer = vi.fn().mockResolvedValue(undefined)
  const view = render(createElement(QuestionCard, { request: { ...request, questions: [{ id: 'optional', optional: true, options: [{ label: 'A' }] }] }, onAnswer }))
  expect(view.getByRole('radio', { name: 'A' })).toHaveProperty('checked', false)
  fireEvent.click(view.getByRole('button', { name: '跳过问题' }))
  await waitFor(() => expect(onAnswer).toHaveBeenCalledWith([]))
})

it('accepts multiple options and never treats whitespace as a meaningful response', async () => {
  const onAnswer = vi.fn().mockResolvedValue(undefined)
  const view = render(createElement(QuestionCard, { request: { ...request, mode: 'nonblocking', questions: [{ id: 'choices', multiple: true, options: [{ label: 'A' }, { label: 'B' }] }] }, onAnswer }))
  fireEvent.change(view.getByRole('textbox'), { target: { value: '  ' } })
  expect(view.getByRole('button', { name: '提交回答' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(view.getByRole('checkbox', { name: 'A' }))
  fireEvent.click(view.getByRole('checkbox', { name: 'B' }))
  fireEvent.click(view.getByRole('button', { name: '提交回答' }))
  await waitFor(() => expect(onAnswer).toHaveBeenCalledWith([{ questionId: 'choices', text: '', selected: ['A', 'B'] }]))
})

it('aborts old-session polling and ignores a late response after switching sessions', async () => {
  let resolveOld: ((value: { questions: PendingQuestionRequest[] }) => void) | undefined
  const questions = vi.spyOn(api, 'questions')
    .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    .mockResolvedValue({ questions: [] })
  const view = render(createElement(QuestionPanel, { key: 'old', workspace: '/work', sessionId: 'old', running: false }))
  const oldSignal = questions.mock.calls[0]?.[2]
  view.rerender(createElement(QuestionPanel, { key: 'new', workspace: '/work', sessionId: 'new', running: false }))
  expect(oldSignal?.aborted).toBe(true)
  resolveOld?.({ questions: [request] })
  await waitFor(() => expect(questions).toHaveBeenCalledTimes(2))
  expect(view.queryByRole('form', { name: '会话问题' })).toBeNull()
})

it('resumes the durable queued answer when a nonblocking question is answered after the run', async () => {
  vi.spyOn(api, 'questions').mockResolvedValue({ questions: [{ ...request, mode: 'nonblocking' }] })
  const answer = vi.spyOn(api, 'answerQuestions').mockResolvedValue({ accepted: true, resumeQueued: true })
  const resume = vi.fn()
  const view = render(createElement(QuestionPanel, { workspace: '/work', sessionId: 'session', running: false, onResumeQueued: resume }))
  const textbox = await view.findByRole('textbox', { name: '选择方向：补充或自定义回答' })
  fireEvent.change(textbox, { target: { value: '继续我的方案' } })
  fireEvent.click(view.getByRole('button', { name: '提交回答' }))
  await waitFor(() => expect(resume).toHaveBeenCalledTimes(1))
  expect(answer.mock.calls[0]?.slice(0, 4)).toEqual(['/work', 'session', 'request', [{ questionId: 'direction', text: '继续我的方案' }]])
  expect(view.queryByRole('form', { name: '会话问题' })).toBeNull()
})
