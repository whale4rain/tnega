import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@tnega/core'
import { SessionLog } from '@tnega/session'
import { userQuestions } from '../src/index.js'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'tnega-questions-'))
  const session = new SessionLog(join(directory, 'session.jsonl'))
  await session.init()
  const ctx = new Context()
  const fiber = ctx.plugin(userQuestions, { resolveSession: (agentId: string) => agentId === 'a' ? session : undefined })
  await fiber
  cleanups.push(async () => { await fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  return { ctx, session, fiber }
}

it('returns immediately in nonblocking mode and persists without changing model messages', async () => {
  const { ctx, session } = await setup()
  const result = await ctx.userQuestions.ask({ mode: 'nonblocking', questions: [{ id: 'q', options: [{ label: 'A' }] }] }, { agentId: 'a' })
  expect(result.status).toBe('pending')
  expect(await ctx.userQuestions.listPending('a')).toHaveLength(1)
  await ctx.userQuestions.answer(result.requestId, [{ questionId: 'q', text: 'My own idea' }], { agentId: 'a' })
  expect(await ctx.userQuestions.listPending('a')).toEqual([])
  expect(await session.deriveMessages()).toEqual([])
  expect((await session.read()).filter(event => event.type === 'meta').map(event => event.payload.kind)).toContain('question/answered')
})

it('waits for a blocking answer, validates options and preserves the question in the result', async () => {
  const { ctx } = await setup()
  let resolved = false
  const waiting = ctx.userQuestions.ask({ mode: 'blocking', questions: [{ id: 'q', question: 'Choose', options: [{ label: 'A' }, { label: 'B' }] }] }, { agentId: 'a' }).then(result => { resolved = true; return result })
  const pending = await waitForPending(ctx)
  expect(resolved).toBe(false)
  await expect(ctx.userQuestions.answer(pending.requestId, [{ questionId: 'q', selected: ['missing'] }], { agentId: 'a' })).rejects.toThrow('Unknown option')
  await ctx.userQuestions.answer(pending.requestId, [{ questionId: 'q', selected: ['A'], text: 'With changes' }], { agentId: 'a' })
  expect(await waiting).toMatchObject({ status: 'answered', answers: [{ questionId: 'q', selected: ['A'], text: 'With changes' }] })
  await expect(ctx.userQuestions.answer(pending.requestId, [{ questionId: 'q', text: 'duplicate' }], { agentId: 'a' })).rejects.toThrow('already')
})

async function waitForPending(ctx: Context) {
  for (let count = 0; count < 100; count += 1) {
    const pending = (await ctx.userQuestions.listPending('a'))[0]
    if (pending) return pending
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error('question did not open')
}

it('cancels a blocking wait on abort and on plugin disposal', async () => {
  const { ctx, fiber } = await setup()
  const controller = new AbortController()
  const first = ctx.userQuestions.ask({ questions: [{ id: 'q' }] }, { agentId: 'a', signal: controller.signal })
  const rejected = expect(first).rejects.toMatchObject({ code: 'QUESTION_CANCELLED' })
  await waitForPending(ctx)
  controller.abort()
  await rejected
  expect(await ctx.userQuestions.listPending('a')).toEqual([])
  const second = ctx.userQuestions.ask({ questions: [{ id: 'q' }] }, { agentId: 'a' })
  const disposed = expect(second).rejects.toMatchObject({ code: 'QUESTION_CANCELLED' })
  await waitForPending(ctx)
  await fiber.dispose()
  await disposed
})

it('reloads nonblocking questions but cancels orphaned blocking questions', async () => {
  const { ctx, session } = await setup()
  const pending = await ctx.userQuestions.ask({ mode: 'nonblocking', questions: [{ id: 'q', optional: true }] }, { agentId: 'a' })
  await session.append('meta', { kind: 'question/opened', request: { requestId: 'orphan', agentId: 'a', mode: 'blocking', questions: [{ id: 'q' }], createdAt: Date.now(), status: 'pending' } })
  await session.flush()
  const other = new Context()
  const mounted = other.plugin(userQuestions, { resolveSession: () => session })
  await mounted
  cleanups.push(async () => mounted.dispose())
  expect(await other.userQuestions.listPending('a')).toMatchObject([{ requestId: pending.requestId }])
  expect((await session.read()).some(event => event.type === 'meta' && event.payload.kind === 'question/cancelled' && event.payload.requestId === 'orphan')).toBe(true)
  await expect(other.userQuestions.answer(pending.requestId, [], { agentId: 'wrong' })).rejects.toThrow()
  await other.userQuestions.answer(pending.requestId, [], { agentId: 'a' })
  expect(await other.userQuestions.listPending('a')).toEqual([])
})

it('rejects duplicate ids, conflicting option selections and unanswered required questions', async () => {
  const { ctx } = await setup()
  await expect(ctx.userQuestions.ask({ questions: [{ id: 'q' }, { id: 'q' }] }, { agentId: 'a' })).rejects.toThrow('Duplicate')
  const pending = await ctx.userQuestions.ask({ mode: 'nonblocking', questions: [{ id: 'q', options: [{ label: 'A' }, { label: 'B' }] }] }, { agentId: 'a' })
  await expect(ctx.userQuestions.answer(pending.requestId, [], { agentId: 'a' })).rejects.toThrow('Required')
  await expect(ctx.userQuestions.answer(pending.requestId, [{ questionId: 'q', selected: ['A', 'B'] }], { agentId: 'a' })).rejects.toThrow('one option')
})

it('does not cancel a blocking request while its durable opening is still being flushed', async () => {
  const { ctx, session } = await setup()
  let finish: () => void = () => {}
  const flush = session.flush.bind(session)
  vi.spyOn(session, 'flush').mockImplementationOnce(async () => {
    await new Promise<void>(resolve => { finish = resolve })
    return flush()
  })
  const waiting = ctx.userQuestions.ask({ questions: [{ id: 'q' }] }, { agentId: 'a' })
  for (let count = 0; count < 100 && !(await session.read()).some(event => event.type === 'meta' && event.payload.kind === 'question/opened'); count += 1) await new Promise(resolve => setTimeout(resolve, 2))
  const listing = ctx.userQuestions.listPending('a')
  finish()
  const pending = (await listing)[0]
  expect(pending).toBeDefined()
  if (!pending) throw new Error('missing pending question')
  await ctx.userQuestions.answer(pending.requestId, [{ questionId: 'q', text: 'answer' }], { agentId: 'a' })
  expect(await waiting).toMatchObject({ status: 'answered' })
  expect((await session.read()).some(event => event.type === 'meta' && event.payload.kind === 'question/cancelled')).toBe(false)
})

it('keeps cancellation live after an answer persistence failure', async () => {
  const { ctx, session } = await setup()
  const controller = new AbortController()
  const waiting = ctx.userQuestions.ask({ questions: [{ id: 'q' }] }, { agentId: 'a', signal: controller.signal })
  const rejection = expect(waiting).rejects.toMatchObject({ code: 'QUESTION_CANCELLED' })
  const pending = await waitForPending(ctx)
  vi.spyOn(session, 'flush').mockRejectedValueOnce(new Error('disk unavailable'))
  await expect(ctx.userQuestions.answer(pending.requestId, [{ questionId: 'q', text: 'answer' }], { agentId: 'a' })).rejects.toThrow('disk unavailable')
  controller.abort()
  await rejection
  expect(await ctx.userQuestions.listPending('a')).toEqual([])
})

it('retries durable delivery before settlement while preserving the first submitted answer', async () => {
  const { session } = await setup()
  const ctx = new Context()
  const deliver = vi.fn().mockRejectedValueOnce(new Error('queue unavailable')).mockResolvedValue(undefined)
  const fiber = ctx.plugin(userQuestions, { resolveSession: () => session, deliverNonblocking: deliver })
  await fiber
  cleanups.push(() => fiber.dispose())
  const request = await ctx.userQuestions.ask({ mode: 'nonblocking', questions: [{ id: 'q' }] }, { agentId: 'a' })
  await expect(ctx.userQuestions.answer(request.requestId, [{ questionId: 'q', text: 'first' }], { agentId: 'a' })).rejects.toThrow('queue unavailable')
  expect(await ctx.userQuestions.listPending('a')).toHaveLength(1)
  const result = await ctx.userQuestions.answer(request.requestId, [{ questionId: 'q', text: 'second' }], { agentId: 'a' })
  expect(result.answers).toEqual([{ questionId: 'q', text: 'first' }])
  expect(deliver.mock.calls[1]?.[1]).toEqual(result.answers)
})
