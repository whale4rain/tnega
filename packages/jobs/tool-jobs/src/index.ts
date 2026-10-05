import { randomUUID } from 'node:crypto'
import type { Context } from '@tnega/core'
import type { AgentRegistry, LiveAgent, SystemPromptService } from '@tnega/agent'
import { JobOwnerDisposedError, type JobOutcome, type JobProgress, type JobRead } from '@tnega/jobs'
import { renderToolResult, type SessionLog } from '@tnega/session'
import {
  ADOPT_BACKGROUND_PROCESS, localUrls, processNotes, stripAnsi, ToolNotFoundError,
  type AdoptedProcess, type ToolsService, type ToolExecuteOptions,
} from '@tnega/tools'
import type { SubagentEntry, SubagentStartRequest } from '@tnega/subagent'

export interface ToolJobsConfig {
  waitTimeoutMs?: number
  maxWaitTimeoutMs?: number
  maxOutputChars?: number
  resolveSession?: (agentId?: string) => SessionLog | undefined
}
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
  const registry: AgentRegistry | undefined = ctx.get('agents')
  const owner = registry?.get(options.agentId)
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

async function runSubagent(ctx: Context, request: SubagentStartRequest, signal: AbortSignal, options: ToolExecuteOptions): Promise<JobOutcome> {
  signal.throwIfAborted()
  const service = ctx.get('subagents')
  const agents = ctx.get('agents')
  if (!service || !agents) throw new Error('background subagents require subagents and agents services')
  const tools: ToolsService = ctx.get('tools')
  let child: LiveAgent | undefined
  const cancel = (): void => child?.cancel({ type: 'user' })
  signal.addEventListener('abort', cancel, { once: true })
  try {
    const result = await tools.execute('spawn_subagent', {
      task: request.task, ...(request.label ? { label: request.label } : {}),
      ...(request.mode ? { mode: request.mode } : {}),
    }, { signal, agentId: request.parentId, jobStart: true,
      onSubagentStarted: (entry: SubagentEntry) => {
        child = agents.get(entry.id)
        if (signal.aborted) cancel()
      },
      ...(typeof options.ptcParentCallId === 'string' ? { ptcParentCallId: options.ptcParentCallId } : {}),
    })
    if (!result.ok) {
      cancel()
      await child?.whenIdle()
      return { status: 'failed', output: renderToolResult(result) }
    }
    if (!child) throw new Error('started Subagent is unavailable')
    await child.whenIdle()
    await child.session.flush()
    const events = await child.session.read()
    const end = [...events].reverse().find(event => event.type === 'turn/end')
    const message = [...events].reverse().find(event => event.type === 'assistant/message')
    const reason = end?.type === 'turn/end' ? end.payload.finishReason : 'error'
    return {
      status: signal.aborted ? 'killed' : reason === 'stop' ? 'completed' : 'failed',
      detail: `subagent ${child.id}: ${reason}`,
      output: message?.type === 'assistant/message' ? message.payload.content : '(no final text)',
    }
  } catch (error) {
    cancel()
    await child?.whenIdle()
    throw error
  } finally { signal.removeEventListener('abort', cancel) }
}

export const toolJobs = {
  name: 'tool-jobs', inject: ['tools', 'jobs'],
  apply(ctx: Context, config: ToolJobsConfig = {}): void {
    const waitDefault = config.waitTimeoutMs ?? 30_000
    const waitCap = config.maxWaitTimeoutMs ?? 60_000
    const outputCap = config.maxOutputChars ?? 64_000
    for (const value of [waitDefault, waitCap, outputCap]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('job tool limits must be positive integers')
    }
    if (waitDefault > waitCap) throw new Error('job wait default exceeds maximum')
    const jobs = ctx.jobs
    const tools: ToolsService = ctx.get('tools')
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
    const prompt: SystemPromptService | undefined = ctx.get('systemPrompt')
    if (prompt) ctx.effect(() => prompt.registerSection({
      name: 'tool:jobs', order: 45,
      content: 'Use job_start for independent long-running tools or Subagent tasks; for a command that keeps running (a dev server, a watcher) use job_start with tool=shell, since plain shell waits for the command to exit. Track job IDs, continue useful work, and collect relevant results with job_output before your final answer. Use wait only when blocked; job_kill cancels unnecessary work. Completion notices enter your inbox. Jobs survive Agent Runs but not runtime shutdown.',
    }))
    tools.register({
      schema: {
        name: 'job_start', description: 'Start a long-running tool or Subagent task in the background and return its job ID. Tool calls retain normal permissions and deadlines. Set kind=subagent with task to delegate; otherwise specify tool and input. With tool=shell the command runs as a background process without a deadline (a dev server, a watcher): the call returns once it runs, with its first output; job_output reads new output and local URLs; job_kill stops it. Collect results with job_output.',
        parameters: { type: 'object', properties: {
          kind: { type: 'string', enum: ['tool', 'subagent'] },
          tool: { type: 'string' }, input: {}, task: { type: 'string' },
          label: { type: 'string' }, mode: { type: 'string', enum: ['spawn', 'fork'] },
          wait_for_url_ms: { type: 'integer', minimum: 0, description: 'tool=shell: wait up to this long (max 60000) for a local URL in the output, e.g. 15000 for a dev server' },
        }, additionalProperties: false },
      },
      metadata: { permissionBoundary: 'nested-tools' },
      async execute(input, options) {
        options.signal?.throwIfAborted()
        const value = fields(input)
        const kind = value.kind ?? 'tool'
        if (kind !== 'tool' && kind !== 'subagent') throw new Error('kind must be tool or subagent')
        const owner = ownerOf(ctx, options)
        const label = value.label === undefined ? undefined : required(value.label, 'label')
        const session = owner?.session ?? config.resolveSession?.(options.agentId)
        let run: (signal: AbortSignal) => Promise<JobOutcome>
        let defaultLabel: string
        let progress: (() => JobProgress | undefined) | undefined
        let started: Promise<void> | undefined
        const live: { adopted?: AdoptedProcess } = {}
        if (kind === 'subagent') {
          if (!owner) throw new Error('background Subagent tasks require a live Agent')
          const task = required(value.task, 'task')
          if (value.mode !== undefined && value.mode !== 'spawn' && value.mode !== 'fork') throw new Error('mode must be spawn or fork')
          defaultLabel = task.slice(0, 128)
          run = async signal => {
            const callId = `${options.callId ?? randomUUID()}/job/${randomUUID()}`
            signal.throwIfAborted()
            await session?.append('meta', { kind: 'job/dispatch-start', callId, name: 'spawn_subagent', task: task.slice(0, outputCap) })
            await session?.flush()
            const outcome = await runSubagent(ctx, { parentId: owner.id, task,
              ...(label ? { label } : {}), ...(value.mode === 'fork' ? { mode: 'fork' } : {}),
            }, signal, options)
            if (outcome.output !== undefined) outcome.output = outcome.output.slice(0, outputCap)
            await session?.append('meta', { kind: 'job/dispatch-result', callId, name: 'spawn_subagent', ...outcome })
            await session?.flush()
            return outcome
          }
        } else {
          const name = required(value.tool, 'tool')
          const definition = tools.list().find(tool => tool.schema.name === name)
          if (!definition) throw new ToolNotFoundError(name, tools.list().map(tool => tool.schema.name).filter(tool => !tool.startsWith('job_')))
          if (name.startsWith('job_') || name === 'spawn_subagent' || definition.metadata?.background === false) {
            throw new Error('tool cannot be backgrounded; use kind=subagent for Subagent work')
          }
          defaultLabel = name
          if (definition.metadata?.backgroundProcess === true) {
            const command = (value.input as { command?: unknown } | undefined)?.command
            if (typeof command === 'string' && command.trim()) defaultLabel = command.trim().slice(0, 128)
            let markStarted: () => void = () => undefined
            started = new Promise<void>(resolve => { markStarted = resolve })
            progress = () => {
              const adopted = live.adopted
              if (!adopted) return undefined
              const output = adopted.entry.process.output()
              return { output: stripAnsi(output), urls: localUrls(output), processId: adopted.entry.id }
            }
            run = async signal => {
              const callId = `${options.callId ?? randomUUID()}/job/${randomUUID()}`
              try {
                signal.throwIfAborted()
                await session?.append('meta', { kind: 'job/dispatch-start', callId, name,
                  input: renderToolResult({ ok: true, output: value.input ?? {} }).slice(0, outputCap) })
                await session?.flush()
                const result = await tools.execute(name, value.input ?? {}, {
                  callId, signal, ...(options.agentId ? { agentId: options.agentId } : {}),
                  ...(typeof options.ptcParentCallId === 'string' ? { ptcParentCallId: options.ptcParentCallId } : {}),
                  [ADOPT_BACKGROUND_PROCESS]: (adopted: AdoptedProcess) => { live.adopted = adopted; markStarted() },
                })
                const adopted = live.adopted
                if (!result.ok || !adopted) {
                  const output = renderToolResult(result).slice(0, outputCap)
                  await session?.append('meta', { kind: 'job/dispatch-result', callId, name, ok: result.ok, output })
                  await session?.flush()
                  return { status: result.ok ? 'completed' : 'failed', output }
                }
                const code = await exitOrAbort(adopted, signal)
                const output = (): string => tail(stripAnsi(adopted.entry.process.output()), outputCap)
                if (code === 'aborted' && signal.reason instanceof JobOwnerDisposedError && adopted.shared) {
                  // The runtime is going away, not a person stopping the job:
                  // the workspace keeps the process (a dev server survives a
                  // settings change) and the user can still stop it there.
                  return { status: 'killed', detail: `still running in the workspace as ${adopted.entry.id}`, output: output() }
                }
                if (code === 'aborted') await adopted.stop()
                const exit = adopted.entry.process.exitCode()
                await session?.append('meta', { kind: 'job/dispatch-result', callId, name, ok: exit === 0, output: output() })
                await session?.flush()
                // A stopped job reads as stopped, not as the exit code the kill caused.
                if (code === 'aborted') return { status: 'killed', output: output() }
                return {
                  status: exit === 0 ? 'completed' : 'failed',
                  ...(typeof exit === 'number' ? { detail: `exit code ${exit}` } : {}),
                  output: output(),
                }
              } finally { markStarted() }
            }
          } else run = async signal => {
            const callId = `${options.callId ?? randomUUID()}/job/${randomUUID()}`
            signal.throwIfAborted()
            await session?.append('meta', { kind: 'job/dispatch-start', callId, name,
              input: renderToolResult({ ok: true, output: value.input ?? {} }).slice(0, outputCap) })
            await session?.flush()
            signal.throwIfAborted()
            const result = await tools.execute(name, value.input ?? {}, {
              callId, signal, ...(options.agentId ? { agentId: options.agentId } : {}),
              ...(typeof options.ptcParentCallId === 'string' ? { ptcParentCallId: options.ptcParentCallId } : {}),
            })
            const output = renderToolResult(result).slice(0, outputCap)
            await session?.append('meta', { kind: 'job/dispatch-result', callId, name, ok: result.ok, output })
            await session?.flush()
            return { status: result.ok ? 'completed' : 'failed', output }
          }
        }
        if (value.wait_for_url_ms !== undefined && (typeof value.wait_for_url_ms !== 'number' || value.wait_for_url_ms < 0)) {
          throw new Error('wait_for_url_ms must be a non-negative number')
        }
        const id = jobs.start({ kind, label: label ?? defaultLabel, ...(owner ? { owner } : {}), run, ...(progress ? { progress } : {}) })
        if (!started) return { job_id: id, status: 'running' }
        processes.set(id, live)
        // A process job answers once the command runs (after any approval),
        // and for a server once it printed a local URL.
        await abortable(started, options.signal)
        const waitMs = Math.min(typeof value.wait_for_url_ms === 'number' ? value.wait_for_url_ms : 0, 60_000)
        const deadline = Date.now() + waitMs
        while (Date.now() < deadline && !options.signal?.aborted
          && jobs.get(id, owner).status === 'running' && !progress?.()?.urls?.length) {
          await new Promise(resolve => setTimeout(resolve, 200))
        }
        return describeProcessJob(jobs.read(id, owner), START_OUTPUT_CHARS, true, reads, live.adopted)
      },
    })
    tools.register({ schema: { name: 'job_list', description: 'List your running and finished background jobs.', parameters: { type: 'object', properties: {} } },
      execute(_input, options) { return jobs.list(ownerOf(ctx, options)) },
    })
    tools.register({ schema: { name: 'job_output', description: 'Read a background job final result; for a shell process, its new output since the last read, its status and local URLs. wait=true waits up to timeout_ms for the job to finish without cancelling work on timeout. Cancelling this tool stops only the wait.',
      parameters: { type: 'object', properties: {
        job_id: { type: 'string' }, wait: { type: 'boolean' }, timeout_ms: { type: 'integer', minimum: 1 },
        all: { type: 'boolean', description: 'shell process: return all retained output instead of only new output' },
      }, required: ['job_id'] } },
      async execute(input, options) {
        const value = fields(input)
        const id = required(value.job_id, 'job_id')
        const owner = ownerOf(ctx, options)
        if (value.wait !== undefined && typeof value.wait !== 'boolean') throw new Error('wait must be boolean')
        if (value.wait) {
          const timeout = value.timeout_ms ?? waitDefault
          if (typeof timeout !== 'number' || !Number.isSafeInteger(timeout) || timeout < 1) throw new Error('timeout_ms must be a positive integer')
          await jobs.wait(id, Math.min(timeout, waitCap), owner, options.signal)
        }
        if (value.all !== undefined && typeof value.all !== 'boolean') throw new Error('all must be boolean')
        const read = jobs.read(id, owner)
        const process = processes.get(id)
        if (!process) return read
        return describeProcessJob(read, READ_OUTPUT_CHARS, value.all === true, reads, process.adopted)
      },
    })
    tools.register({ schema: { name: 'job_kill', description: 'Request background job cancellation. It remains stopping until execution releases resources.',
      parameters: { type: 'object', properties: { job_id: { type: 'string' }, reason: { type: 'string' } }, required: ['job_id'] } },
      execute(input, options) {
        const value = fields(input)
        if (value.reason !== undefined && typeof value.reason !== 'string') throw new Error('reason must be string')
        return jobs.kill(required(value.job_id, 'job_id'), ownerOf(ctx, options), typeof value.reason === 'string' ? value.reason : undefined)
      },
    })
  },
}
