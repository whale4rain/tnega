import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@tnega/core'
import type { SessionEvent, SessionLog } from '@tnega/session'

export interface UserQuestionOption { label: string; description?: string }
export interface UserQuestion {
  id: string
  question?: string
  options?: UserQuestionOption[]
  multiple?: boolean
  optional?: boolean
}
export type QuestionMode = 'blocking' | 'nonblocking'
export interface AskUserQuestionInput { mode?: QuestionMode; questions: UserQuestion[] }
export interface QuestionAnswerItem { questionId: string; selected?: string[]; text?: string }
export type QuestionAnswers = QuestionAnswerItem[]
export interface PendingQuestionRequest {
  requestId: string
  agentId: string
  callId?: string
  mode: QuestionMode
  questions: UserQuestion[]
  createdAt: number
  status: 'pending'
}
export interface AnsweredQuestionRequest extends Omit<PendingQuestionRequest, 'status'> {
  status: 'answered'
  answers: QuestionAnswers
}
export type QuestionResult = PendingQuestionRequest | AnsweredQuestionRequest
export interface QuestionAnsweredEvent { request: PendingQuestionRequest; answers: QuestionAnswers }
export interface UserQuestionsConfig {
  resolveSession: (agentId: string) => SessionLog | undefined | Promise<SessionLog | undefined>
  /** Deliver durable steering before committing a nonblocking answer. Must be idempotent. */
  deliverNonblocking?: (request: PendingQuestionRequest, answers: QuestionAnswers) => Promise<void>
}
export interface QuestionCaller { agentId: string; callId?: string; signal?: AbortSignal }

declare module '@tnega/core' {
  interface Context { userQuestions: UserQuestionsService }
}

export class UserQuestionError extends Error {
  override name = 'UserQuestionError'
  constructor(message: string, readonly code: string) { super(message) }
}
function invalid(message: string): never { throw new UserQuestionError(message, 'INVALID_QUESTION') }
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') invalid(`${field} must be boolean`)
  return value
}
function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') invalid(`${field} must be a string`)
  return value
}

/** Shared boundary validation for tools, persisted metadata and HTTP composition. */
export function parseQuestionInput(value: unknown): Required<AskUserQuestionInput> {
  if (!record(value)) invalid('Question input must be an object')
  const mode = value.mode ?? 'blocking'
  if (mode !== 'blocking' && mode !== 'nonblocking') invalid('mode must be blocking or nonblocking')
  if (!Array.isArray(value.questions) || value.questions.length === 0 || value.questions.length > 12) invalid('questions must contain 1–12 questions')
  const ids = new Set<string>()
  const questions = value.questions.map(item => {
    if (!record(item) || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 128) invalid('Each question requires a stable nonempty id')
    if (ids.has(item.id)) invalid(`Duplicate question id: ${item.id}`)
    ids.add(item.id)
    const question = optionalString(item.question, 'question')
    if (question !== undefined && question.length > 8000) invalid('question is too long')
    const multiple = optionalBoolean(item.multiple, 'multiple')
    const optional = optionalBoolean(item.optional, 'optional')
    let options: UserQuestionOption[] | undefined
    if (item.options !== undefined) {
      if (!Array.isArray(item.options) || item.options.length > 20) invalid('options must be an array with at most 20 entries')
      const labels = new Set<string>()
      options = item.options.map(option => {
        if (!record(option) || typeof option.label !== 'string' || !option.label.trim() || option.label.length > 1000) invalid('Each option requires a nonempty label')
        if (labels.has(option.label)) invalid(`Duplicate option label: ${option.label}`)
        labels.add(option.label)
        const description = optionalString(option.description, 'description')
        if (description !== undefined && description.length > 4000) invalid('Option description is too long')
        return { label: option.label, ...(description === undefined ? {} : { description }) }
      })
    }
    return { id: item.id, ...(question === undefined ? {} : { question }), ...(options === undefined ? {} : { options }), ...(multiple === undefined ? {} : { multiple }), ...(optional === undefined ? {} : { optional }) }
  })
  return { mode, questions }
}

export function parseQuestionAnswers(request: PendingQuestionRequest, value: unknown): QuestionAnswers {
  if (!Array.isArray(value)) invalid('answers must be an array')
  const seen = new Set<string>()
  const result = value.map(item => {
    if (!record(item) || typeof item.questionId !== 'string') invalid('Each answer requires questionId')
    const question = request.questions.find(question => question.id === item.questionId)
    if (!question) invalid(`Unknown question: ${item.questionId}`)
    if (seen.has(item.questionId)) invalid(`Duplicate answer: ${item.questionId}`)
    seen.add(item.questionId)
    let selected: string[] | undefined
    if (item.selected !== undefined) {
      if (!Array.isArray(item.selected)) invalid('selected must be an array')
      selected = item.selected.map(label => {
        if (typeof label !== 'string' || !question.options?.some(option => option.label === label)) invalid(`Unknown option for ${item.questionId}`)
        return label
      })
      if (new Set(selected).size !== selected.length) invalid('Duplicate option selection')
      if (!question.multiple && selected.length > 1) invalid('Select at most one option')
    }
    const text = optionalString(item.text, 'text')?.trim()
    if (text !== undefined && text.length > 32000) invalid('Answer text is too long')
    if (!question.optional && !selected?.length && !text) invalid(`Required question is unanswered: ${question.id}`)
    return { questionId: item.questionId, ...(selected === undefined ? {} : { selected }), ...(text === undefined ? {} : { text }) }
  })
  for (const question of request.questions) if (!question.optional && !seen.has(question.id)) invalid(`Required question is unanswered: ${question.id}`)
  return result
}

function parsePending(value: unknown): PendingQuestionRequest | undefined {
  if (!record(value) || typeof value.requestId !== 'string' || typeof value.agentId !== 'string' || typeof value.createdAt !== 'number') return
  try {
    const input = parseQuestionInput(value)
    return { requestId: value.requestId, agentId: value.agentId, createdAt: value.createdAt, status: 'pending', ...input, ...(typeof value.callId === 'string' ? { callId: value.callId } : {}) }
  } catch { return }
}

/** Presentation metadata never becomes model history or conversation configuration. */
export function pendingQuestionsFromEvents(events: readonly SessionEvent[]): PendingQuestionRequest[] {
  const pending = new Map<string, PendingQuestionRequest>()
  for (const event of events) {
    if (event.type !== 'meta') continue
    if (event.payload.kind === 'question/opened') {
      const request = parsePending(event.payload.request)
      if (request) pending.set(request.requestId, request)
    } else if (event.payload.kind === 'question/answered' || event.payload.kind === 'question/cancelled') {
      if (typeof event.payload.requestId === 'string') pending.delete(event.payload.requestId)
    }
  }
  return [...pending.values()]
}

export function formatQuestionAnswer(request: PendingQuestionRequest, answers: QuestionAnswers): string {
  return [`User answered nonblocking request ${request.requestId}:`, ...request.questions.map(question => {
    const answer = answers.find(answer => answer.questionId === question.id)
    const response = [...(answer?.selected ?? []), ...(answer?.text ? [answer.text] : [])].join('\n') || '(skipped)'
    return `${question.question?.trim() || question.id}\n${response}`
  })].join('\n\n')
}

interface WaitingQuestion {
  request: PendingQuestionRequest
  session: SessionLog
  resolve?: (result: AnsweredQuestionRequest) => void
  reject?: (error: UserQuestionError) => void
  cleanup?: () => void
  opening: Promise<void>
  signal?: AbortSignal
  settled: boolean
}

export class UserQuestionsService extends Service {
  private readonly pending = new Map<string, WaitingQuestion>()
  private disposed = false
  constructor(ctx: Context, private readonly config: UserQuestionsConfig) {
    super(ctx, 'userQuestions')
    ctx.fiber.effect(() => async () => {
      this.disposed = true
      await Promise.all([...this.pending.values()].filter(entry => entry.request.mode === 'blocking').map(entry => this.cancel(entry)))
      this.pending.clear()
    }, 'user question waits')
  }

  async ask(input: AskUserQuestionInput, caller: QuestionCaller): Promise<QuestionResult> {
    const parsed = parseQuestionInput(input)
    if (this.disposed || caller.signal?.aborted) throw new UserQuestionError('Question cancelled', 'QUESTION_CANCELLED')
    const session = await this.config.resolveSession(caller.agentId)
    if (!session) throw new UserQuestionError('Question session is unavailable', 'QUESTION_SESSION_UNAVAILABLE')
    if (this.disposed || caller.signal?.aborted) throw new UserQuestionError('Question cancelled', 'QUESTION_CANCELLED')
    const request: PendingQuestionRequest = { requestId: randomUUID(), agentId: caller.agentId, ...parsed, createdAt: Date.now(), status: 'pending', ...(caller.callId === undefined ? {} : { callId: caller.callId }) }
    let opened: () => void = () => {}
    let failedOpening: (error: unknown) => void = () => {}
    const opening = new Promise<void>((resolve, reject) => { opened = resolve; failedOpening = reject })
    void opening.catch(() => {})
    const entry: WaitingQuestion = { request, session, settled: false, opening, ...(caller.signal ? { signal: caller.signal } : {}) }
    let waiting: Promise<AnsweredQuestionRequest> | undefined
    if (request.mode === 'blocking') {
      waiting = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject })
      // Cancellation may happen before durable opening finishes; attach a handler immediately.
      void waiting.catch(() => {})
    }
    this.pending.set(request.requestId, entry)
    try {
      await session.append('meta', { kind: 'question/opened', request })
      await session.flush()
      opened()
    } catch (error) {
      failedOpening(error)
      this.pending.delete(request.requestId)
      entry.reject?.(new UserQuestionError('Question could not be persisted', 'QUESTION_PERSISTENCE_FAILED'))
      throw error
    }
    if (request.mode === 'blocking') {
      const abort = () => { void this.cancel(entry).catch(error => { entry.reject?.(new UserQuestionError(String(error), 'QUESTION_CANCELLED')) }) }
      caller.signal?.addEventListener('abort', abort, { once: true })
      entry.cleanup = () => caller.signal?.removeEventListener('abort', abort)
      if (caller.signal?.aborted || this.disposed) await this.cancel(entry)
    }
    if (this.disposed && request.mode === 'nonblocking') {
      await this.cancel(entry)
      throw new UserQuestionError('Question cancelled', 'QUESTION_CANCELLED')
    }
    if (!entry.settled) {
      try { await this.ctx.parallel('user-questions/opened', request) }
      catch (error) { await this.cancel(entry); throw error }
    }
    return waiting ?? structuredClone(request)
  }

  async listPending(agentId?: string): Promise<PendingQuestionRequest[]> {
    if (agentId !== undefined) {
      const session = await this.config.resolveSession(agentId)
      if (session) {
        for (const request of pendingQuestionsFromEvents(await session.read())) {
          if (request.agentId !== agentId || this.pending.has(request.requestId)) continue
          if (request.mode === 'blocking') {
            await session.append('meta', { kind: 'question/cancelled', requestId: request.requestId, reason: 'runtime unavailable' })
            await session.flush()
          } else this.pending.set(request.requestId, { request, session, settled: false, opening: Promise.resolve() })
        }
      }
    }
    await Promise.all([...this.pending.values()].map(entry => entry.opening.catch(() => {})))
    return [...this.pending.values()].filter(entry => !entry.settled && (agentId === undefined || entry.request.agentId === agentId)).map(entry => structuredClone(entry.request))
  }

  async answer(requestId: string, answers: unknown, caller: Pick<QuestionCaller, 'agentId'>): Promise<AnsweredQuestionRequest> {
    await this.listPending(caller.agentId)
    const entry = this.pending.get(requestId)
    if (!entry || entry.request.agentId !== caller.agentId || entry.settled) throw new UserQuestionError('Question is unavailable or already answered', 'QUESTION_ALREADY_SETTLED')
    let parsed = parseQuestionAnswers(entry.request, answers)
    entry.settled = true
    try {
      if (entry.request.mode === 'nonblocking' && this.config.deliverNonblocking) {
        const submitted = (await entry.session.read()).find(event => event.type === 'meta'
          && event.payload.kind === 'question/submitted' && event.payload.requestId === requestId)
        if (submitted?.type === 'meta') parsed = parseQuestionAnswers(entry.request, submitted.payload.answers)
        else {
          await entry.session.append('meta', { kind: 'question/submitted', requestId, answers: parsed })
          await entry.session.flush()
        }
        await this.config.deliverNonblocking(entry.request, parsed)
      }
      await entry.session.append('meta', { kind: 'question/answered', requestId, answers: parsed })
      await entry.session.flush()
    } catch (error) {
      entry.settled = false
      if (entry.signal?.aborted || this.disposed) await this.cancel(entry)
      throw error
    }
    entry.cleanup?.()
    this.pending.delete(requestId)
    const result: AnsweredQuestionRequest = { ...entry.request, status: 'answered', answers: parsed }
    entry.resolve?.(structuredClone(result))
    await this.ctx.parallel('user-questions/answered', { request: structuredClone(entry.request), answers: structuredClone(parsed) } satisfies QuestionAnsweredEvent)
    return result
  }

  private async cancel(entry: WaitingQuestion): Promise<void> {
    await entry.opening.catch(() => {})
    if (entry.settled) return
    entry.settled = true
    entry.cleanup?.()
    try {
      await entry.session.append('meta', { kind: 'question/cancelled', requestId: entry.request.requestId, reason: 'cancelled' })
      await entry.session.flush()
    } finally {
      this.pending.delete(entry.request.requestId)
      entry.reject?.(new UserQuestionError('Question cancelled', 'QUESTION_CANCELLED'))
    }
  }
}

export const userQuestions = {
  name: 'user-questions',
  apply(ctx: Context, config: UserQuestionsConfig): void { new UserQuestionsService(ctx, config) },
}
