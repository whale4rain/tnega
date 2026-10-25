import { randomUUID } from 'node:crypto'
import type { Context } from '@tnega/core'
import type { LiveAgent } from '@tnega/agent'
import { JobOwnerDisposedError, type JobOutcome, type JobProgress, type JobRead } from '@tnega/jobs'
import { renderToolResult, type SessionLog } from '@tnega/session'
import {
  ADOPT_BACKGROUND_PROCESS, localUrls, processNotes, stripAnsi,
  type AdoptedProcess, type ToolExecuteOptions, type ToolRequest, type ToolResult,
} from '@tnega/tools'

export interface ToolJobsConfig {
  waitTimeoutMs?: number
  maxWaitTimeoutMs?: number
  maxOutputChars?: number
  resolveSession?: (agentId?: string) => SessionLog | undefined
}

/**
 * The `shell` parameter that turns one command into a background job. Declared
 * by the tool, honoured here: `@tnega/tools` owns the tool and its schema, this
 * package owns the job registry, and neither has to depend on the other.
 */
export const RUN_IN_BACKGROUND = 'runInBackground'
/** `shell` parameter: wait this long for the command to print a local URL. */
export const WAIT_FOR_URL_MS = 'waitForUrlMs'

function fields(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('job input must be an object')
  return Object.fromEntries(Object.entries(value))
}
function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a nonempty string`)
  return value
}
function ownerOf(ctx: Context, options: ToolExecuteOptions): LiveAgent | undefined {
  if (!options.agentId) return undefined
  const registry = ctx.get('agents', false)
  // A headless run has one Agent and no registry: its calls are unattributed.
  if (!registry) return undefined
  const owner = registry.get(options.agentId)
  if (!owner) throw new Error('background jobs require an active Agent identity')
  return owner
}

const START_OUTPUT_CHARS = 4_000
const READ_OUTPUT_CHARS = 8_000

function tail(text: string, chars: number): string {
  return text.length > chars ? `…${text.slice(-chars)}` : text
}

/** Resolves with the exit code, or `aborted` when the job is stopped first. */
function exitOrAbort(adopted: AdoptedProcess, signal: AbortSignal): Promise<number | null | 'aborted'> {
  if (signal.aborted) return Promise.resolve('aborted')
  return new Promise(resolve => {
    const abort = (): void => resolve('aborted')
    signal.addEventListener('abort', abort, { once: true })
    void adopted.entry.process.exited.then(code => {
      signal.removeEventListener('abort', abort)
      resolve(code)
    })
  })
}

function abortable(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason ?? new Error('aborted'))
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(() => { signal.removeEventListener('abort', abort); resolve() })
  })
}

/** A process job as the model reads it: status, URLs, and the output it has not seen yet. */
function describeProcessJob(
  read: JobRead, chars: number, all: boolean, seen: Map<string, number>, adopted: AdoptedProcess | undefined,
): Record<string, unknown> {
  const output = read.output ?? ''
  const before = seen.get(read.job.id) ?? 0
  const fresh = all || output.length < before ? output : output.slice(before)
  seen.set(read.job.id, output.length)
  const notes = adopted && read.job.status === 'running' ? processNotes(adopted.entry.process, fresh, before === 0) : {}
  return {
    job_id: read.job.id, status: read.job.status,
    ...(read.job.processId ? { process_id: read.job.processId } : {}),
    urls: read.job.urls ?? [],
    ...(read.job.detail ? { detail: read.job.detail } : {}),
    output: tail(fresh, chars),
    ...notes,
  }
}

/**
 * Background work and the three tools that read it.
 *
 * A long-running command is a property of `shell`, not a second tool: the model
 * asks for the command it wants and adds `runInBackground`. This plugin owns the
 * job registry, so it intercepts that call after policy has already decided it
 * (the guard has run, an approval may have been answered) and starts the same
 * tool body with the adopt hook. Re-entering `ctx.tools.execute` would ask a
 * person to approve one command twice.
 *
 * A background Subagent needs no job: `spawn_subagent` already returns its id
 * immediately and reports completion into the inbox, and `list_subagent` can
 * wait for it.
 */
export const toolJobs = {
  name: 'tool-jobs', inject: ['tools', 'jobs'],
  apply(ctx: Context, config: ToolJobsConfig = {}): void {
    const waitDefault = config.waitTimeoutMs ?? 30_000
    // A model that has to guess a sleep length waits too little, looks again,
    // and pays a round trip each time. One long wait it can cancel is cheaper.
    const waitCap = config.maxWaitTimeoutMs ?? 600_000
    const outputCap = config.maxOutputChars ?? 64_000
    for (const value of [waitDefault, waitCap, outputCap]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('job tool limits must be positive integers')
    }
    if (waitDefault > waitCap) throw new Error('job wait default exceeds maximum')
    const jobs = ctx.jobs
    const tools = ctx.tools
    // Process jobs, and how much of each one's output the model has read.
    const processes = new Map<string, { adopted?: AdoptedProcess }>()
    const reads = new Map<string, number>()
    jobs.attachController()
    jobs.onDone(async (job, owner) => {
      if (!owner || job.reported) return
      // Durable next-step input; an idle Agent consumes it on its next activation.
      await owner.inject({ messages: [{ role: 'user', name: 'plugin:tool-jobs',
        content: `Background job ${job.id} (${job.label}) finished: ${job.status}. Collect its result with job_output.` }] })
    })
    const prompt = ctx.get('systemPrompt', false)
    if (prompt) ctx.effect(() => prompt.registerSection({
      name: 'tool:jobs', order: 45,
      content: 'A command that keeps running (a dev server, a watcher, a long build you do not need to wait for) belongs in the background: call shell with runInBackground, which returns a job id and its first output. Keep working, then read job_output. When you are blocked on a job, wait for it with job_output({job_id, wait: true, timeout_ms}) — cancelling that wait does not stop the job. job_kill stops work you no longer need. Completion notices arrive in your inbox. Jobs survive Agent Runs but not runtime shutdown.',
    }))

    // ── the background form of shell ──
    ctx.on('tools/execute', async (request: ToolRequest, next: () => Promise<ToolResult>) => {
      if (request.name !== 'shell' || request.tool.metadata?.backgroundProcess !== true) return next()
      const input = fields(request.input)
      if (input[RUN_IN_BACKGROUND] !== true) return next()
      const command: Record<string, unknown> = { ...input }
      delete command[RUN_IN_BACKGROUND]
      const owner = ownerOf(ctx, request.options)
      const session = owner?.session ?? config.resolveSession?.(request.options.agentId)
      const text = typeof command.command === 'string' && command.command.trim()
        ? command.command.trim().slice(0, 128)
        : 'shell'
      const live: { adopted?: AdoptedProcess } = {}
      let markStarted: () => void = () => undefined
      const started = new Promise<void>(resolve => { markStarted = resolve })
      const id = jobs.start({
        kind: 'process',
        label: text,
        ...(owner ? { owner } : {}),
        progress(): JobProgress | undefined {
          const adopted = live.adopted
          if (!adopted) return undefined
          const output = adopted.entry.process.output()
          return { output: stripAnsi(output), urls: localUrls(output), processId: adopted.entry.id }
        },
        async run(signal) {
          const callId = `${request.options.callId ?? randomUUID()}/job/${randomUUID()}`
          const note = async (kind: string, payload: Record<string, unknown>): Promise<void> => {
            await session?.append('meta', { kind, callId, name: 'shell', ...payload })
            await session?.flush()
          }
          try {
            signal.throwIfAborted()
            await note('job/dispatch-start', {
              input: renderToolResult({ ok: true, output: command }).slice(0, outputCap),
            })
            let output: unknown
            try {
              output = await request.tool.execute(command, {
                ...request.options,
                callId,
                signal,
                [ADOPT_BACKGROUND_PROCESS]: (adopted: AdoptedProcess) => {
                  live.adopted = adopted
                  markStarted()
                },
              })
            } catch (error) {
              markStarted()
              throw error
            }
            const adopted = live.adopted
            if (!adopted) {
              // The body ran the command instead of handing over a process.
              const rendered = renderToolResult({ ok: true, output }).slice(0, outputCap)
              await note('job/dispatch-result', { ok: true, output: rendered })
              return { status: 'completed', output: rendered }
            }
            markStarted()
            const code = await exitOrAbort(adopted, signal)
            const printed = (): string => tail(stripAnsi(adopted.entry.process.output()), outputCap)
            if (code === 'aborted' && signal.reason instanceof JobOwnerDisposedError && adopted.shared) {
              // The runtime is going away, not a person stopping the job: the
              // workspace keeps the process and the user can still stop it there.
              return { status: 'killed', detail: `still running in the workspace as ${adopted.entry.id}`, output: printed() }
            }
            if (code === 'aborted') await adopted.stop()
            const exit = adopted.entry.process.exitCode()
            await note('job/dispatch-result', { ok: exit === 0, output: printed() })
            // A stopped job reads as stopped, not as the exit code the kill caused.
            if (code === 'aborted') return { status: 'killed', output: printed() }
            return {
              status: exit === 0 ? 'completed' : 'failed',
              ...(typeof exit === 'number' ? { detail: `exit code ${exit}` } : {}),
              output: printed(),
            } satisfies JobOutcome
          } finally {
            markStarted()
          }
        },
      })
      processes.set(id, live)
      // A process job answers once the command runs (after any approval), and
      // for a server once it printed a local URL.
      await abortable(started, request.options.signal)
      const waitMs = Math.min(
        typeof command[WAIT_FOR_URL_MS] === 'number' ? command[WAIT_FOR_URL_MS] as number : 0,
        60_000,
      )
      const deadline = Date.now() + waitMs
      while (Date.now() < deadline && !request.options.signal?.aborted
        && jobs.get(id, owner).status === 'running' && !live.adopted?.entry.process.output().match(/https?:\/\//i)) {
        await new Promise(resolve => setTimeout(resolve, 200))
      }
      return {
        ok: true,
        name: request.name,
        ...(request.options.callId ? { callId: request.options.callId } : {}),
        input: request.input,
        output: describeProcessJob(jobs.read(id, owner), START_OUTPUT_CHARS, true, reads, live.adopted),
        startedAt: request.startedAt,
        durationMs: Date.now() - request.startedAt,
      }
    })

    tools.register({
      schema: { name: 'job_list', description: 'List your running and finished background jobs.', parameters: { type: 'object', properties: {} } },
      isConcurrencySafe: () => true,
      execute(_input, options) { return jobs.list(ownerOf(ctx, options)) },
    })
    tools.register({
      schema: {
        name: 'job_output',
        description: 'Read a background job final result; for a shell process, its new output since the last read, its status and local URLs. wait=true waits up to timeout_ms for the job to finish without cancelling work on timeout. Cancelling this tool stops only the wait.',
        parameters: {
          type: 'object',
          properties: {
            job_id: { type: 'string' }, wait: { type: 'boolean' }, timeout_ms: { type: 'integer', minimum: 1 },
            all: { type: 'boolean', description: 'shell process: return all retained output instead of only new output' },
          },
          required: ['job_id'],
        },
      },
      isConcurrencySafe: () => true,
      async execute(input, options) {
        const value = fields(input)
        const id = required(value.job_id, 'job_id')
        const owner = ownerOf(ctx, options)
        if (value.wait !== undefined && typeof value.wait !== 'boolean') throw new Error('wait must be boolean')
        if (value.wait) {
          const timeout = value.timeout_ms ?? waitDefault
          if (typeof timeout !== 'number' || !Number.isSafeInteger(timeout) || timeout < 1) throw new Error('timeout_ms must be a positive integer')
          const waited = Math.min(timeout, waitCap)
          await jobs.wait(id, waited, owner, options.signal)
          if (jobs.get(id, owner).status === 'running' || jobs.get(id, owner).status === 'stopping') {
            // Saying so beats letting the model guess how long to sleep next.
            const read = jobs.read(id, owner)
            const process = processes.get(id)
            const described = process
              ? describeProcessJob(read, READ_OUTPUT_CHARS, value.all === true, reads, process.adopted)
              : read as unknown as Record<string, unknown>
            return {
              ...described,
              waited_ms: waited,
              hint: `still running after waiting ${Math.round(waited / 1000)}s; wait again with a larger timeout_ms (up to ${Math.round(waitCap / 1000)}s), or keep working and read it later`,
            }
          }
        }
        if (value.all !== undefined && typeof value.all !== 'boolean') throw new Error('all must be boolean')
        const read = jobs.read(id, owner)
        const process = processes.get(id)
        if (!process) return read
        return describeProcessJob(read, READ_OUTPUT_CHARS, value.all === true, reads, process.adopted)
      },
    })
    tools.register({
      schema: {
        name: 'job_kill',
        description: 'Request background job cancellation. It remains stopping until execution releases resources.',
        parameters: { type: 'object', properties: { job_id: { type: 'string' }, reason: { type: 'string' } }, required: ['job_id'] },
      },
      execute(input, options) {
        const value = fields(input)
        if (value.reason !== undefined && typeof value.reason !== 'string') throw new Error('reason must be string')
        return jobs.kill(required(value.job_id, 'job_id'), ownerOf(ctx, options), typeof value.reason === 'string' ? value.reason : undefined)
      },
    })
  },
}
