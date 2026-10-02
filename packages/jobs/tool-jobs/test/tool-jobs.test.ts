import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@tnega/core'
import { agents, type AgentRegistry, type LLMAdapter } from '@tnega/agent'
import { session, type SessionLog } from '@tnega/session'
import { tools, type ToolsService, type ToolStagePayload } from '@tnega/tools'
import { jobsLocal } from '../../jobs-local/src/index.js'
import { toolJobs } from '../src/index.js'
import { subagentLocal } from '../../../subagent/subagent-local/src/index.js'
import { toolSubagent } from '../../../subagent/tool-subagent/src/index.js'
import { afterEach, expect, it } from 'vitest'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-jobs-'))
  dirs.push(dir)
  const root = new Context()
  await root.plugin(session, { file: join(dir, 'session.jsonl') })
  await root.plugin(tools)
  await root.plugin(jobsLocal)
  const log: SessionLog = root.get('session')
  const registry: ToolsService = root.get('tools')
  await root.plugin(toolJobs, { resolveSession: () => log })
  return { root, dir, log, registry }
}

it('returns immediately, preserves permissions, and audits work before and after execution', async () => {
  const { root, registry, log } = await setup()
  let finish!: () => void
  const pending = new Promise<void>(done => { finish = done })
  let executed = false
  registry.register({ schema: { name: 'slow', description: 'slow tool' }, execute: async () => {
    const events = await log.read()
    expect(events.some(event => event.type === 'meta' && event.payload.kind === 'job/dispatch-start')).toBe(true)
    executed = true
    await pending
    return 'finished work'
  } })
  const result = await registry.execute('job_start', { tool: 'slow', input: {} })
  expect(result.ok).toBe(true)
  const [job] = root.jobs.list()
  expect(job?.status).toBe('running')
  await Promise.resolve()
  finish()
  await root.jobs.wait(job!.id, 1000)
  const read = await registry.execute('job_output', { job_id: job!.id })
  expect(read.ok).toBe(true)
  expect(read.output).toMatchObject({ output: 'finished work', job: { status: 'completed' } })
  expect(executed).toBe(true)
  expect((await log.read()).some(event => event.type === 'meta' && event.payload.kind === 'job/dispatch-result')).toBe(true)
  registry.guard(request => {
    if (request.name !== 'slow') return undefined
    expect(request.options.approvedElevation).toBeUndefined()
    return 'denied'
  })
  const denied = await registry.execute('job_start', { tool: 'slow', input: {} }, { approvedElevation: true })
  expect(denied.ok).toBe(true)
  const blocked = root.jobs.list().at(-1)!
  expect((await root.jobs.wait(blocked.id, 1000)).status).toBe('failed')
  expect(root.jobs.read(blocked.id).output).toContain('denied')
  await root.fiber.dispose()
})

it('does not tie background cancellation to the launching call signal', async () => {
  const { root, registry } = await setup()
  let cancelled = false
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  registry.register({ schema: { name: 'slow', description: 'slow tool' }, execute: async (_, options) => {
    await new Promise<void>(resolve => {
      options.signal?.addEventListener('abort', () => { cancelled = true; resolve() }, { once: true })
      started()
    })
    return 'released'
  } })
  const launch = new AbortController()
  await registry.execute('job_start', { tool: 'slow' }, { signal: launch.signal })
  const job = root.jobs.list()[0]!
  await ready
  launch.abort()
  expect((await root.jobs.wait(job.id, 5)).status).toBe('running')
  expect(cancelled).toBe(false)
  await registry.execute('job_kill', { job_id: job.id })
  expect((await root.jobs.wait(job.id, 1000)).status).toBe('killed')
  expect(cancelled).toBe(true)
  await root.fiber.dispose()
})

it('fences owner access, records completion in durable inbox, and cancels on owner disposal', async () => {
  const { root, dir, registry } = await setup()
  await root.plugin(agents)
  const liveAgents: AgentRegistry = root.get('agents')
  const owner = await liveAgents.create({ file: join(dir, 'owner.jsonl'), id: 'owner', manualStreaming: true })
  const other = await liveAgents.create({ file: join(dir, 'other.jsonl'), id: 'other', manualStreaming: true })
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  registry.register({ schema: { name: 'fast', description: 'fast tool' }, execute: async () => { await pending; return 'done' } })
  await registry.execute('job_start', { tool: 'fast' }, { agentId: owner.agent.id })
  const job = root.jobs.list(owner.agent)[0]!
  expect(root.jobs.list(other.agent)).toEqual([])
  expect(() => root.jobs.get(job.id, other.agent)).toThrow('not found')
  const collected = root.jobs.wait(job.id, 1000, owner.agent)
  finish()
  await collected
  // Explicit collection suppresses the duplicate completion notice.
  expect(owner.agent.inbox.size).toBe(0)
  registry.register({ schema: { name: 'pending', description: 'pending tool' }, execute: async (_, options) => {
    await new Promise<void>(resolve => options.signal?.addEventListener('abort', () => resolve(), { once: true }))
    return 'cancelled'
  } })
  await registry.execute('job_start', { tool: 'pending' }, { agentId: owner.agent.id })
  await root.jobs.wait(root.jobs.list(owner.agent).at(-1)!.id, 5, owner.agent)
  await owner.dispose()
  expect(root.jobs.list(owner.agent)).toEqual([])
  await other.dispose()
  await root.fiber.dispose()
})

it.each(['completed', 'killed', 'post-failure'])('tracks real background Subagent work as %s', async outcome => {
  const { root, dir, registry } = await setup()
  await root.plugin(agents)
  const liveAgents: AgentRegistry = root.get('agents')
  const parent = await liveAgents.create({ file: join(dir, 'parent.jsonl'), id: 'parent', manualStreaming: true })
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  let aborted = false
  const llm: LLMAdapter = { async complete(_messages, _tools, options) {
    const abort = (): void => { aborted = true; finish() }
    options?.signal?.addEventListener('abort', abort, { once: true })
    started()
    try { await pending; return { content: 'child result', finishReason: 'stop' } }
    finally { options?.signal?.removeEventListener('abort', abort) }
  } }
  await root.plugin(subagentLocal, { cwd: dir, llm })
  await root.plugin(toolSubagent)
  if (outcome === 'completed') root.on('tools/post-execute', (payload: ToolStagePayload, next: (payload: ToolStagePayload) => unknown) => {
    if (payload.request.name === 'spawn_subagent') payload.result.output = 'model-visible start message'
    return next(payload)
  })
  if (outcome === 'post-failure') root.on('tools/post-execute', async (payload: ToolStagePayload, next: (payload: ToolStagePayload) => unknown) => {
    if (payload.request.name === 'spawn_subagent') { await ready; throw new Error('post-execute failed') }
    return next(payload)
  })
  const launch = await registry.execute('job_start', { kind: 'subagent', task: 'bounded work' }, { agentId: parent.agent.id })
  expect(launch.ok).toBe(true)
  const job = root.jobs.list(parent.agent)[0]!
  await ready
  if (outcome !== 'post-failure') expect(root.jobs.get(job.id, parent.agent).status).toBe('running')
  if (outcome === 'killed') {
    await registry.execute('job_kill', { job_id: job.id }, { agentId: parent.agent.id })
  } else if (outcome === 'completed') finish()
  const result = await registry.execute('job_output', { job_id: job.id, wait: true, timeout_ms: 1000 }, { agentId: parent.agent.id })
  expect(result.ok).toBe(true)
  expect(result.output).toMatchObject({ job: { status: outcome === 'post-failure' ? 'failed' : outcome } })
  expect(aborted).toBe(outcome !== 'completed')
  expect(parent.agent.inbox.size).toBeLessThanOrEqual(1)
  await parent.dispose()
  await root.fiber.dispose()
})

it('delivers uncollected completion through the durable inbox once', async () => {
  const { root, dir, registry } = await setup()
  await root.plugin(agents)
  const liveAgents: AgentRegistry = root.get('agents')
  const parent = await liveAgents.create({ file: join(dir, 'notice.jsonl'), id: 'notice', manualStreaming: true })
  const delivered = new Promise<void>(resolve => root.on('agent/inbox/inserted', () => resolve()))
  registry.register({ schema: { name: 'fast', description: 'fast' }, execute: () => 'done' })
  await registry.execute('job_start', { tool: 'fast' }, { agentId: parent.agent.id })
  await delivered
  expect(parent.agent.inbox.size).toBe(1)
  const events = await parent.agent.session.read()
  expect(events.filter(event => event.type === 'agent/inbox/spliced')).toHaveLength(1)
  await parent.dispose()
  await root.fiber.dispose()
})
