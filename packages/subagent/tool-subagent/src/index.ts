import type { Context } from '@tnega/core'
import { setTimeout as delay } from 'node:timers/promises'
import type { SubagentService } from '@tnega/subagent'
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

export const toolSubagent = {
  name: 'tool-subagent',
  inject: ['subagents', 'tools'],
  apply(ctx: Context): void {
    const subagents = ctx.get('subagents') as SubagentService
    const tools = ctx.get('tools') as ToolsService
    tools.register({
      schema: {
        name: 'spawn_subagent',
        description: 'Start a bounded independent task in a child Agent. Returns its ID immediately. Use spawn for a self-contained task; use fork only when the child needs completed conversation history. Assign separate files to agents that edit code. Check progress with list_subagent.',
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'Specific goal, relevant context, scope, expected result, and verification criteria.' },
            label: { type: 'string', description: 'Short name for the task.' },
            mode: { type: 'string', enum: ['spawn', 'fork'], description: 'spawn starts empty; fork copies only completed parent turns.' },
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
        const entry = await subagents.start({
          parentId: caller(options.agentId),
          task: value.task,
          ...(typeof value.label === 'string' ? { label: value.label } : {}),
          ...(value.mode === 'fork' ? { mode: 'fork' as const } : {}),
        })
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
          ? entries.map(entry => `${entry.id} [${entry.status}] ${entry.label} (parent=${entry.parentId}, mode=${entry.mode})`).join('\n')
          : '(no subagents)'
      },
    })
    tools.register({
      schema: {
        name: 'send_agent_message',
        description: 'Send task direction or findings to your direct parent or child Agent through its durable inbox. Acceptance does not wait for a reply.',
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
