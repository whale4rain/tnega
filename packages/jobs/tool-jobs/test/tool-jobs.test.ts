import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@tnega/core'
import { agents, type AgentRegistry } from '@tnega/agent'
import { session, type SessionLog } from '@tnega/session'
import { builtinTools, tools, type ExecutionProvider, type ToolsService } from '@tnega/tools'
import { jobsLocal } from '../../jobs-local/src/index.js'
import { toolJobs } from '../src/index.js'
import { afterEach, describe, expect, it } from 'vitest'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

/** A process whose output and exit the test controls. */
function fakeProcess(options: { output?: string } = {}) {
  let text = options.output ?? ''
  let killed = 0
  let code: number | null | undefined
  let exit: (code: number | null) => void = () => undefined
  const exited = new Promise<number | null>(resolve => { exit = resolve })
  const provider: ExecutionProvider = {
    runShell: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    runProcess: async () => ({ exitCode: 0, stdout: '', stderr: '', stdoutTruncated: false }),
    fetchHttp: async () => ({ status: 200, ok: true, headers: {}, body: '', truncated: false }),
    startShell: async () => ({
      pid: 1,
      output: () => text,
      exitCode: () => code,
      exited,
      kill: async () => { killed += 1; code = null; exit(null) },
    }),
  }
  return {
    provider,
    print(more: string) { text += more },
    finish(exitCode: number) { code = exitCode; exit(exitCode) },
    get kills() { return killed },
  }
}

async function setup(options: { execution?: ExecutionProvider } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'tnega-jobs-'))
  dirs.push(cwd)
  const root = new Context()
  await root.plugin(session, { file: join(cwd, 'session.jsonl') })
  await root.plugin(tools)
  await root.plugin(builtinTools, { cwd, allowShell: true, ...options })
  await root.plugin(jobsLocal)
  const log: SessionLog = root.get('session')
  await root.plugin(toolJobs, { resolveSession: () => log })
  const registry: ToolsService = root.get('tools')
  return { root, cwd, log, registry }
}

type ProcessJob = { job_id: string; status: string; output: string; waited_ms?: number; hint?: string; detail?: string }

describe('a backgrounded shell command', () => {
  it('takes one authorization decision, audits the work, and answers with a job id', async () => {
    const fake = fakeProcess({ output: 'building\n' })
    const { root, registry, log } = await setup({ execution: fake.provider })
    const guarded: string[] = []
    registry.guard(request => { guarded.push(request.name); return undefined })

    const started = await registry.execute('shell', { command: 'npm run build', runInBackground: true })
    expect(started.ok).toBe(true)
    expect(started.output).toMatchObject({ status: 'running' })
    // One call, one decision: the job starts the same body, not a second call.
    expect(guarded).toEqual(['shell'])
    expect(root.jobs.list()).toMatchObject([{ kind: 'process', label: 'npm run build', status: 'running' }])
    const events = await log.read()
    expect(events.some(event => event.type === 'meta' && event.payload.kind === 'job/dispatch-start')).toBe(true)

    fake.finish(0)
    const job = root.jobs.list()[0]!
    await root.jobs.wait(job.id, 1_000)
    // The launch already returned the first output, so read all of it.
    const read = (await registry.execute('job_output', { job_id: job.id, all: true })).output as ProcessJob
    expect(read).toMatchObject({ status: 'completed' })
    expect(read.output).toContain('building')
    expect((await log.read()).some(event => event.type === 'meta' && event.payload.kind === 'job/dispatch-result')).toBe(true)
    await root.fiber.dispose()
  })

  it('keeps running when the launching call is cancelled', async () => {
    const fake = fakeProcess()
    const { root, registry } = await setup({ execution: fake.provider })
    const launch = new AbortController()
    await registry.execute('shell', { command: 'node --watch', runInBackground: true }, { signal: launch.signal })
    const job = root.jobs.list()[0]!

    launch.abort()
    expect((await root.jobs.wait(job.id, 5)).status).toBe('running')
    await registry.execute('job_kill', { job_id: job.id })
    expect((await root.jobs.wait(job.id, 1_000)).status).toBe('killed')
    expect(fake.kills).toBe(1)
    await root.fiber.dispose()
  })

  it('says how long it waited instead of letting the model guess a sleep', async () => {
    const fake = fakeProcess()
    const { root, registry } = await setup({ execution: fake.provider })
    await registry.execute('shell', { command: 'node --watch', runInBackground: true })
    const job = root.jobs.list()[0]!

    const read = (await registry.execute('job_output', { job_id: job.id, wait: true, timeout_ms: 50 })).output as ProcessJob
    expect(read).toMatchObject({ status: 'running', waited_ms: 50 })
    expect(read.hint).toMatch(/still running/)
    await registry.execute('job_kill', { job_id: job.id })
    await root.jobs.wait(job.id, 1_000)
    await root.fiber.dispose()
  })

  it('still refuses to run inline when no jobs plugin is mounted', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tnega-jobs-none-'))
    dirs.push(cwd)
    const root = new Context()
    await root.plugin(tools)
    await root.plugin(builtinTools, { cwd, allowShell: true, execution: fakeProcess().provider })
    const registry: ToolsService = root.get('tools')
    const refused = await registry.execute('shell', { command: 'npm run dev', runInBackground: true })
    expect(refused.ok).toBe(false)
    expect(refused.error?.message).toContain('cannot run background commands')
    await root.fiber.dispose()
  })
})

describe('two reads of one job at once', () => {
  it('may repeat the same new output but never loses it', async () => {
    const fake = fakeProcess({ output: 'first\n' })
    const { root, registry } = await setup({ execution: fake.provider })
    await registry.execute('shell', { command: 'node --watch', runInBackground: true })
    const job = root.jobs.list()[0]!
    // The launch already showed 'first'; this read sees only what came after.
    fake.print('second\n')

    // Accepted cost of treating job_output as concurrency-safe: both reads
    // advance one per-job cursor, so the new text may be delivered twice or
    // once with the other read empty. Which one wins depends on how the two
    // calls interleave; neither loses anything.
    const [left, right] = await Promise.all([
      registry.execute('job_output', { job_id: job.id }),
      registry.execute('job_output', { job_id: job.id }),
    ])
    const outputs = [left, right].map(result => (result.output as ProcessJob).output)
    expect(outputs.some(output => output.includes('second'))).toBe(true)

    // What must hold: the text is still readable afterwards, exactly once.
    const later = (await registry.execute('job_output', { job_id: job.id })).output as ProcessJob
    expect(later.output).toBe('')
    fake.finish(0)
    await root.jobs.wait(job.id, 1_000)
    const final = (await registry.execute('job_output', { job_id: job.id, all: true })).output as ProcessJob
    expect(final.output).toContain('second')
    await root.fiber.dispose()
  })
})

describe('ownership', () => {
  it('fences jobs to their agent and notices completion in its inbox', async () => {
    const fake = fakeProcess()
    const { root, cwd, registry } = await setup({ execution: fake.provider })
    await root.plugin(agents)
    const liveAgents: AgentRegistry = root.get('agents')
    const owner = await liveAgents.create({ file: join(cwd, 'owner.jsonl'), id: 'owner', manualStreaming: true })
    const other = await liveAgents.create({ file: join(cwd, 'other.jsonl'), id: 'other', manualStreaming: true })
    const notified = new Promise<void>(resolve => root.on('agent/inbox/inserted', () => resolve()))

    await registry.execute('shell', { command: 'npm run build', runInBackground: true }, { agentId: owner.agent.id })
    const job = root.jobs.list(owner.agent)[0]!
    expect(root.jobs.list(other.agent)).toEqual([])
    expect(() => root.jobs.get(job.id, other.agent)).toThrow('not found')

    fake.finish(0)
    await notified
    expect(owner.agent.inbox.size).toBe(1)
    await owner.dispose()
    await other.dispose()
    await root.fiber.dispose()
  })
})
