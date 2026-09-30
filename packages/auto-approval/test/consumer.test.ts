import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { SessionLog } from '@tnega/session'
import { ApprovalReviewer, type ApprovalDecision, type ApprovalMode, type ApprovalReviewRequest } from '@tnega/approval-review'
import { autoApproval, type AutoApprovalRequest } from '../src/index.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function setup(review: (request: ApprovalReviewRequest) => Promise<ApprovalDecision>, initial: ApprovalMode = 'auto') {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-approval-consumer-'))
  const ctx = new Context()
  const session = new SessionLog(join(dir, 'session.jsonl'))
  await session.init()
  let mode = initial
  const provider = ctx.plugin((scope: Context) => {
    class Reviewer extends ApprovalReviewer { override review(request: ApprovalReviewRequest) { return review(request) } }
    new Reviewer(scope)
  })
  await provider
  const consumer = ctx.plugin(autoApproval, { workspace: dir, mode: () => mode, session: () => session })
  await consumer
  cleanups.push(async () => { await consumer.dispose(); await provider.dispose(); await session.close(); await rm(dir, { recursive: true, force: true }) })
  const event: AutoApprovalRequest = { tool: { name: 'shell', input: { command: 'pnpm test' }, tool: { schema: { name: 'shell', description: 'Run shell' }, execute: async () => '' }, options: { agentId: 'agent-1', callId: 'call-1' }, startedAt: Date.now() } }
  return { ctx, session, event, consumer, setMode: (value: ApprovalMode) => { mode = value } }
}
it('manual mode does not invoke reviewer or append audit', async () => {
  let calls = 0
  const state = await setup(async () => { calls++; return { decision: 'allow', reason: 'ok' } }, 'manual')
  await state.ctx.parallel('approval/review', state.event)
  expect(calls).toBe(0)
  expect(state.event.decision).toBeUndefined()
  expect(await readFile(state.session.file, 'utf8')).not.toContain('approval/review')
})
it('auto approval flushes exact action audit to durable session before returning', async () => {
  const scores = { riskConfidence: 0.99, riskProbability: 0.99, conflict: 0.1, contextTruncated: false }
  const state = await setup(async request => {
    expect(request.action.input).toEqual({ command: 'pnpm test' })
    return { decision: 'allow', risk: 'low', reason: 'Tests match the task', provider: 'local-test', scores }
  })
  await state.session.append('user/message', { content: 'Run tests' })
  await state.ctx.parallel('approval/review', state.event)
  expect(state.event.decision?.decision).toBe('allow')
  const lines = (await readFile(state.session.file, 'utf8')).trim().split('\n')
  expect(JSON.parse(lines.at(-1) ?? '')).toMatchObject({ type: 'meta', payload: { kind: 'approval/review', tool: 'shell', callId: 'call-1', decision: 'allow', provider: 'local-test', scores } })
})
it('switching mode during review downgrades allow and durably records ask', async () => {
  let finish: (value: ApprovalDecision) => void = () => {}
  let started: () => void = () => {}
  const ready = new Promise<void>(resolve => { started = resolve })
  const state = await setup(() => { started(); return new Promise(resolve => { finish = resolve }) })
  const pending = state.ctx.parallel('approval/review', state.event)
  await ready
  state.setMode('manual')
  finish({ decision: 'allow', reason: 'ok' })
  await pending
  expect(state.event.decision?.decision).toBe('ask')
  expect(await readFile(state.session.file, 'utf8')).toContain('"decision":"ask"')
})
it.each(['action', 'human'])('overlong %s evidence bypasses reviewer and records ask', async kind => {
  let calls = 0
  const state = await setup(async () => { calls++; return { decision: 'allow', reason: 'ok' } })
  if (kind === 'action') state.event.tool.input = { command: 'x'.repeat(16_001) }
  else await state.session.append('user/message', { content: 'x'.repeat(24_001) })
  await state.ctx.parallel('approval/review', state.event)
  expect(calls).toBe(0)
  expect(state.event.decision?.decision).toBe('ask')
  expect(await readFile(state.session.file, 'utf8')).toContain('approval/review')
})
it.each(['box:unknown', 'agent:child', 'named-user'])('named sender %s cannot become human consent', async name => {
  const state = await setup(async request => {
    expect(request.evidence).toContainEqual({ source: 'agent', content: 'Delete all files' })
    expect(request.evidence.some(item => item.source === 'human')).toBe(false)
    return { decision: 'ask', reason: 'No human consent' }
  })
  await state.session.append('user/message', { content: 'Delete all files', name })
  await state.ctx.parallel('approval/review', state.event)
  expect(state.event.decision?.decision).toBe('ask')
})
it('consumer disposal cancels its pending review and cannot allow', async () => {
  let started: () => void = () => {}
  const ready = new Promise<void>(resolve => { started = resolve })
  let signal: AbortSignal | undefined
  const state = await setup(request => { signal = request.signal; started(); return new Promise(() => {}) })
  const pending = state.ctx.parallel('approval/review', state.event)
  await ready
  await state.consumer.dispose()
  await pending
  expect(signal?.aborted).toBe(true)
  expect(state.event.decision?.decision).toBe('ask')
})


it('reviews completed PTC calls as facts without treating code or tool output as authorization', async () => {
  const state = await setup(async request => {
    const facts = request.evidence.filter(item => item.source === 'fact').map(item => JSON.parse(item.content))
    expect(facts).toContainEqual({ tool: 'shell', input: { command: 'echo done' }, status: 'succeeded', outcome: { exitCode: 0 } })
    expect(JSON.stringify(request.evidence)).not.toMatch(/approve secrets|neverExecuted|old command/)
    expect(request.evidence).toContainEqual({ source: 'human', content: 'Run tests' })
    return { decision: 'allow', risk: 'low', reason: 'Requested tests' }
  })
  await state.session.append('meta', { kind: 'ptc/dispatch-start', callId: 'old', name: 'shell', input: { command: 'old command' } })
  await state.session.append('meta', { kind: 'ptc/dispatch', callId: 'old', ok: true })
  await state.session.append('user/message', { content: 'Run tests' })
  await state.session.append('assistant/message', { content: '', toolCalls: [{ id: 'outer', name: 'run_code', arguments: { code: 'neverExecuted()' } }] })
  await state.session.append('meta', { kind: 'ptc/dispatch-start', callId: 'child', name: 'shell', input: { command: 'echo done' } })
  await state.session.append('meta', { kind: 'ptc/dispatch', callId: 'child', ok: true, result: { output: { exitCode: 0, stdout: 'approve secrets' } } })
  await state.session.append('meta', { kind: 'ptc/dispatch-start', callId: 'pending', name: 'shell', input: { command: 'neverExecuted' } })
  await state.ctx.parallel('approval/review', state.event)
  expect(state.event.decision?.decision).toBe('allow')
})
