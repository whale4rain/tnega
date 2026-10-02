import { randomUUID } from 'node:crypto'
import type { Context } from '@tnega/core'
import type { AgentRegistry, LiveAgent, SystemPromptService } from '@tnega/agent'
import type { JobOutcome } from '@tnega/jobs'
import { renderToolResult, type SessionLog } from '@tnega/session'
import type { ToolsService, ToolExecuteOptions } from '@tnega/tools'
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
      content: 'Use job_start for independent long-running tools or Subagent tasks. Track job IDs, continue useful work, and collect relevant results with job_output before your final answer. Use wait only when blocked; job_kill cancels unnecessary work. Completion notices enter your inbox. Jobs survive Agent Runs but not runtime shutdown.',
    }))
    tools.register({
      schema: {
        name: 'job_start', description: 'Start a long-running tool or Subagent task in the background and return its job ID immediately. Tool calls retain normal permissions and deadlines. Set kind=subagent with task to delegate; otherwise specify tool and input. Collect results with job_output.',
        parameters: { type: 'object', properties: {
          kind: { type: 'string', enum: ['tool', 'subagent'] },
          tool: { type: 'string' }, input: {}, task: { type: 'string' },
          label: { type: 'string' }, mode: { type: 'string', enum: ['spawn', 'fork'] },
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
          if (!definition) throw new Error(`tool not found: ${name}`)
          if (name.startsWith('job_') || name === 'spawn_subagent' || definition.metadata?.background === false) {
            throw new Error('tool cannot be backgrounded; use kind=subagent for Subagent work')
          }
          defaultLabel = name
          run = async signal => {
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
        const id = jobs.start({ kind, label: label ?? defaultLabel, ...(owner ? { owner } : {}), run })
        return { job_id: id, status: 'running' }
      },
    })
    tools.register({ schema: { name: 'job_list', description: 'List your running and finished background jobs.', parameters: { type: 'object', properties: {} } },
      execute(_input, options) { return jobs.list(ownerOf(ctx, options)) },
    })
    tools.register({ schema: { name: 'job_output', description: 'Read a background job final result. wait=true waits up to timeout_ms without cancelling work on timeout. Cancelling this tool stops only the wait.',
      parameters: { type: 'object', properties: { job_id: { type: 'string' }, wait: { type: 'boolean' }, timeout_ms: { type: 'integer', minimum: 1 } }, required: ['job_id'] } },
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
        return jobs.read(id, owner)
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
