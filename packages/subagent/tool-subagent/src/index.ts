import type { Context } from '@tnega/core'
import { DELEGATION_PROMPT } from '@tnega/agent'
import { setTimeout as delay } from 'node:timers/promises'
import type { SubagentEntry, SubagentService } from '@tnega/subagent'
import type { ToolsService } from '@tnega/tools'

function fields(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('tool input must be an object')
  }
  return input as Record<string, unknown>
}

function caller(agentId: string | undefined): string {
  if (!agentId) throw new Error('subagent tools require a live Agent identity')
  return agentId
}

function isStartObserver(value: unknown): value is (entry: SubagentEntry) => void {
  return typeof value === 'function'
}

export const toolSubagent = {
  name: 'tool-subagent',
  inject: ['subagents', 'tools'],
  apply(ctx: Context): void {
    const subagents = ctx.get('subagents') as SubagentService
    const tools = ctx.get('tools') as ToolsService
    const prompts = ctx.get('systemPrompt')
    if (prompts) ctx.fiber.effect(() => prompts.registerSection({ name: 'tool:subagents', order: 40, content: DELEGATION_PROMPT }))
    tools.register({
      schema: {
        name: 'spawn_subagent',
        description: 'Proactively delegate a bounded independent investigation, implementation branch or verification that benefits from its own context. Dispatch useful branches before doing them yourself; keep small or tightly coupled work local and own integration. Returns its ID immediately. Use spawn for a self-contained task; use fork only when the child needs completed conversation history. Assign separate files to agents that edit code. Check progress with list_subagent.',
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'Brief for a context that cannot see this conversation: goal, facts it cannot discover, scope and edit ownership, acceptance checks, expected output. Write it as spec, not conversation.' },
            label: { type: 'string', description: 'Short name for the task.' },
            mode: { type: 'string', enum: ['spawn', 'fork'], description: 'spawn starts empty; fork copies only completed parent turns.' },
            audience: { type: 'string', enum: ['agent', 'user'], description: 'Default agent: the child reports to you as data. user: the child writes the user-facing deliverable — use only when the user must read it.' },
          },
          required: ['task'],
        },
      },
      async execute(input, options) {
        const value = fields(input)
        if (typeof value.task !== 'string') throw new TypeError('task must be a string')
        if (value.label !== undefined && typeof value.label !== 'string') throw new TypeError('label must be a string')
        if (value.mode !== undefined && value.mode !== 'spawn' && value.mode !== 'fork') {
          throw new TypeError('mode must be spawn or fork')
        }
        if (value.audience !== undefined && value.audience !== 'agent' && value.audience !== 'user') {
          throw new TypeError('audience must be agent or user')
        }
        const entry = await subagents.start({
          parentId: caller(options.agentId),
          task: value.task,
          ...(typeof value.label === 'string' ? { label: value.label } : {}),
          ...(value.mode === 'fork' ? { mode: 'fork' as const } : {}),
          ...(value.audience === 'agent' || value.audience === 'user' ? { audience: value.audience } : {}),
          ...(options.jobStart === true ? { reportCompletion: false } : {}),
        })
        // Host-only observer runs before output policies can rewrite the result.
        if (isStartObserver(options.onSubagentStarted)) options.onSubagentStarted(entry)
        return `Started subagent ${entry.id} (${entry.label}). Use list_subagent to check its status.`
      },
    })
    tools.register({
      schema: {
        name: 'list_subagent',
        description: 'Read child Agent status. Use this to monitor work instead of listening for events. If all remaining work depends on a running child, set wait_ms (up to 30000) and call again until it is idle, ready, or failed. Results arrive through your inbox.',
        parameters: {
          type: 'object',
          properties: {
            scope: { type: 'string', enum: ['children', 'descendants'] },
            wait_ms: { type: 'number', description: 'Optional bounded wait for a status change, 0-30000 ms.' },
          },
        },
      },
      async execute(input, options) {
        const value = input === undefined ? {} : fields(input)
        if (value.scope !== undefined && value.scope !== 'children' && value.scope !== 'descendants') {
          throw new TypeError('scope must be children or descendants')
        }
        if (value.wait_ms !== undefined && (typeof value.wait_ms !== 'number'
          || !Number.isSafeInteger(value.wait_ms) || value.wait_ms < 0 || value.wait_ms > 30_000)) {
          throw new TypeError('wait_ms must be an integer from 0 to 30000')
        }
        const scope = value.scope === 'descendants' ? 'descendants' : 'children'
        const parentId = caller(options.agentId)
        let entries = await subagents.list(parentId, scope)
        const initial = entries.map(entry => `${entry.id}:${entry.status}`).join('|')
        const deadline = Date.now() + (typeof value.wait_ms === 'number' ? value.wait_ms : 0)
        while (entries.some(entry => entry.status === 'running') && Date.now() < deadline) {
          await delay(Math.min(500, deadline - Date.now()), undefined, { signal: options.signal })
          entries = await subagents.list(parentId, scope)
          if (entries.map(entry => `${entry.id}:${entry.status}`).join('|') !== initial) break
        }
        return entries.length
          ? entries.map(entry => `${entry.id} [${entry.status}] ${entry.label} (parent=${entry.parentId}, mode=${entry.mode}, audience=${entry.audience})${entry.resultChars !== undefined ? `; final result=${entry.resultChars} characters${entry.resultTruncated ? `, only the first 2000 are kept here — read the whole result with read_subagent_result({"agent_id":"${entry.id}"})` : ', delivered in full to your inbox'}` : ''}`).join('\n')
          : '(no subagents)'
      },
    })
    tools.register({
      schema: {
        name: 'read_subagent_result',
        description: 'Read a bounded page of a direct child\'s full durable final result. Only its owning parent can read it. Character offsets count Unicode code points. Follow nextOffset until null to recover a long result.',
        parameters: {
          type: 'object',
          properties: {
            agent_id: { type: 'string', description: 'Direct child Agent ID.' },
            offset: { type: 'integer', minimum: 0, description: 'Character offset; default 0.' },
            limit: { type: 'integer', minimum: 1, maximum: 16000, description: 'Page size; default 4000, maximum 16000 characters.' },
          },
          required: ['agent_id'],
        },
      },
      async execute(input, options) {
        const value = fields(input)
        if (typeof value.agent_id !== 'string') throw new TypeError('agent_id must be a string')
        if (value.offset !== undefined && (typeof value.offset !== 'number' || !Number.isSafeInteger(value.offset) || value.offset < 0)) {
          throw new TypeError('offset must be a nonnegative integer')
        }
        if (value.limit !== undefined && (typeof value.limit !== 'number' || !Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 16000)) {
          throw new TypeError('limit must be an integer from 1 to 16000')
        }
        return subagents.readResult(caller(options.agentId), value.agent_id, {
          ...(typeof value.offset === 'number' ? { offset: value.offset } : {}),
          ...(typeof value.limit === 'number' ? { limit: value.limit } : {}),
        })
      },
    })
    tools.register({
      schema: {
        name: 'send_agent_message',
        description: 'Send task direction, a decision-blocking issue, or a material discovery to your direct parent or child through its durable inbox. Omit routine progress. Final answers are delivered automatically; do not send them separately. Acceptance does not wait for a reply.',
        parameters: {
          type: 'object',
          properties: {
            agent_id: { type: 'string', description: 'Direct parent or child Agent ID.' },
            message: { type: 'string', description: 'Message to deliver.' },
          },
          required: ['agent_id', 'message'],
        },
      },
      async execute(input, options) {
        const value = fields(input)
        if (typeof value.agent_id !== 'string' || typeof value.message !== 'string') {
          throw new TypeError('agent_id and message must be strings')
        }
        await subagents.send(caller(options.agentId), value.agent_id, value.message)
        return `Message delivered to ${value.agent_id}.`
      },
    })
  },
}
