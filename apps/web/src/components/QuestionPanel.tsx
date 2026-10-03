import { MessageCircleQuestion } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { notifyDesktopWaiting } from '../lib/desktop-completion'
import { errorText } from '../lib/hooks'
import type { PendingQuestionRequest, QuestionAnswerItem } from '../lib/types'

export function QuestionPanel({ workspace, sessionId, running, onResumeQueued }: {
  workspace: string
  sessionId: string
  running: boolean
  onResumeQueued?: () => void
}) {
  const [requests, setRequests] = useState<PendingQuestionRequest[]>([])
  const [error, setError] = useState<string>()
  const answered = useRef(new Set<string>())
  const active = useRef(running)
  active.current = running
  const lifecycle = useRef<AbortController | undefined>(undefined)

  useEffect(() => {
    const controller = new AbortController()
    lifecycle.current = controller
    let timer: ReturnType<typeof setTimeout> | undefined
    async function poll() {
      try {
        const result = await api.questions(workspace, sessionId, controller.signal)
        if (controller.signal.aborted) return
        const pending = result.questions.filter(request => !answered.current.has(request.requestId))
        for (const request of pending) notifyDesktopWaiting(request.requestId)
        setRequests(pending)
        setError(undefined)
      } catch (cause) {
        if (controller.signal.aborted) return
        if (active.current) setError(errorText(cause))
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), active.current ? 1000 : 4000)
    }
    void poll()
    return () => {
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [workspace, sessionId])

  async function answer(request: PendingQuestionRequest, answers: QuestionAnswerItem[]) {
    const signal = lifecycle.current?.signal
    if (signal?.aborted) return
    const result = await api.answerQuestions(workspace, sessionId, request.requestId, answers, signal)
    if (signal?.aborted) return
    if (!result.accepted) throw new Error('这个问题已经结束或已被回答。')
    answered.current.add(request.requestId)
    setRequests(current => current.filter(item => item.requestId !== request.requestId))
    if (result.resumeQueued) onResumeQueued?.()
  }

  if (!requests.length) return null
  return (
    <div className="question-panel">
      {error && <div className="notice" role="status">问题同步暂时失败：{error}</div>}
      {requests.map(request => <QuestionCard key={request.requestId} request={request} onAnswer={answers => answer(request, answers)} />)}
    </div>
  )
}

export function QuestionCard({ request, onAnswer }: {
  request: PendingQuestionRequest
  onAnswer: (answers: QuestionAnswerItem[]) => Promise<void>
}) {
  const [draft, setDraft] = useState<Record<string, QuestionAnswerItem>>({})
  const [error, setError] = useState<string>()
  const [submitting, setSubmitting] = useState(false)
  const locked = useRef(false)
  function update(id: string, patch: Partial<QuestionAnswerItem>) {
    setDraft(current => ({ ...current, [id]: { ...current[id], questionId: id, ...patch } }))
  }
  const complete = request.questions.every(question => question.optional || hasAnswer(draft[question.id]))
  const hasAnswers = request.questions.some(question => hasAnswer(draft[question.id]))
  async function submit() {
    if (locked.current || !complete) return
    locked.current = true
    setSubmitting(true)
    setError(undefined)
    try {
      await onAnswer(request.questions.flatMap(question => {
        const answer = draft[question.id]
        return answer && hasAnswer(answer) ? [{ ...answer, text: answer.text?.trim() }] : []
      }))
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      locked.current = false
      setSubmitting(false)
    }
  }
  return (
    <form className="question-card" aria-label="会话问题" onSubmit={event => { event.preventDefault(); void submit() }}>
      <div className="question-head">
        <MessageCircleQuestion size={16} />
        <strong>需要你的意见</strong>
        <span className="question-mode">{request.mode === 'blocking' ? '正在等待回答' : '继续执行中 · 回答会作为补充指示'}</span>
      </div>
      <div className="question-body">
        {request.questions.map(question => {
          const answer = draft[question.id]
          const selected = answer?.selected ?? []
          return (
            <fieldset key={question.id} className="question-item" disabled={submitting}>
              <legend>{question.question?.trim() || '你的意见'}{question.optional && <span className="muted small">（可跳过）</span>}</legend>
              {question.options?.length ? (
                <div className="question-options">
                  {question.options.map(option => (
                    <label key={option.label} className={`question-option${selected.includes(option.label) ? ' selected' : ''}`}>
                      <input
                        type={question.multiple ? 'checkbox' : 'radio'}
                        name={`${request.requestId}-${question.id}`}
                        checked={selected.includes(option.label)}
                        onChange={event => update(question.id, {
                          selected: question.multiple
                            ? event.target.checked ? [...selected, option.label] : selected.filter(value => value !== option.label)
                            : [option.label],
                        })}
                      />
                      <span><span>{option.label}</span>{option.description && <>{' '}<span className="question-description">{option.description}</span></>}</span>
                    </label>
                  ))}
                </div>
              ) : null}
              {selected.length > 0 && <button type="button" className="button ghost small question-clear" onClick={() => update(question.id, { selected: [] })}>清除选项</button>}
              <textarea
                className="question-text"
                aria-label={`${question.question?.trim() || '你的意见'}：补充或自定义回答`}
                placeholder="也可以写下你的想法…"
                rows={2}
                value={answer?.text ?? ''}
                onChange={event => update(question.id, { text: event.target.value })}
              />
            </fieldset>
          )
        })}
      </div>
      {error && <div className="question-error" role="alert">{error}</div>}
      <div className="question-actions">
        <span className="muted small">{request.mode === 'blocking' ? '提交后继续会话' : '会话结束后提交也会继续处理'}</span>
        <button type="submit" className="button primary small" disabled={!complete || submitting}>{submitting ? '提交中…' : !hasAnswers && complete ? '跳过问题' : '提交回答'}</button>
      </div>
    </form>
  )
}

function hasAnswer(answer: QuestionAnswerItem | undefined): boolean {
  return Boolean(answer?.selected?.length || answer?.text?.trim())
}
