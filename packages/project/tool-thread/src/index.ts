import { agentAddress, type BoxMessageKind, type BoxService } from '@tnega/box'
import type { Context } from '@tnega/core'
import type { ThreadService, ThreadState } from '@tnega/thread'
import type { ToolsService } from '@tnega/tools'

/** `send_thread_message` 允许的消息类型：回报结论，或给子 Thread 新的方向。 */
const MESSAGE_KINDS: readonly BoxMessageKind[] = [
  'progress',
  'request',
  'complete',
  'blocked',
  'failed',
  'dispatch',
]

function fields(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('tool input must be an object')
  }
  return input as Record<string, unknown>
}

function caller(agentId: string | undefined): string {
  if (!agentId) throw new Error('thread tools require a live Agent identity')
  return agentId
}

function statusOf(state: ThreadState): string {
  return state
}

/**
 * Thread 的模型可见工具：委派、查看与回报。
 *
 * 与 `spawn_subagent` 的区别：Thread 是 Project 里可持续交互的 Agent 身份，用户可以自己
 * 打开它、给它留言、改向它；Subagent 是由一次调用驱动的有界任务，用户看不到它。
 * 协调者要交给用户一件「之后还能继续谈」的工作，用 `spawn_thread`。
 */
export const toolThread = {
  name: 'tool-thread',
  inject: ['threads', 'box', 'tools'],
  apply(ctx: Context): void {
    const threads = ctx.get('threads') as ThreadService
    const box = ctx.get('box') as BoxService
    const tools = ctx.get('tools') as ToolsService

    tools.register({
      schema: {
        name: 'spawn_thread',
        description: 'Start a new project thread: an Agent with its own context, model history and folder, which the user can open and talk to directly. Returns its ID immediately; the thread reports back through your inbox. Reuse an existing thread with send_thread_message when the work continues that thread\'s goal.',
        parameters: {
          type: 'object',
          properties: {
            goal: { type: 'string', description: 'What this thread is for, including scope and what "done" means.' },
            label: { type: 'string', description: 'Short name shown on the thread card.' },
            expect: { type: 'string', description: 'What the thread should report back, and in what form.' },
            permission: {
              type: 'string',
              enum: ['read-only', 'workspace-write', 'bypass'],
              description: 'Narrows this thread\'s permission; it can never exceed your own.',
            },
          },
          required: ['goal'],
        },
      },
      async execute(input, options) {
        const value = fields(input)
        if (typeof value.goal !== 'string') throw new TypeError('goal must be a string')
        if (value.label !== undefined && typeof value.label !== 'string') {
          throw new TypeError('label must be a string')
        }
        if (value.expect !== undefined && typeof value.expect !== 'string') {
          throw new TypeError('expect must be a string')
        }
        if (value.permission !== undefined && value.permission !== 'read-only'
          && value.permission !== 'workspace-write' && value.permission !== 'bypass') {
          throw new TypeError('permission must be read-only, workspace-write or bypass')
        }
        const parentId = caller(options.agentId)
        const thread = await threads.spawn({
          parentId,
          goal: value.goal,
          ...(typeof value.label === 'string' ? { label: value.label } : {}),
          ...(typeof value.expect === 'string' ? { expect: value.expect } : {}),
          ...(value.permission === 'read-only' || value.permission === 'workspace-write'
            || value.permission === 'bypass' ? { permission: value.permission } : {}),
        })
        await box.send({
          sender: agentAddress(parentId),
          recipients: [agentAddress(thread.id)],
          // 派工信封在时间线上的位置就是卡片的位置：它出现在你这轮发言之后。
          placement: { kind: 'main' },
          kind: 'dispatch',
          text: typeof value.expect === 'string' && value.expect.trim()
            ? `${value.goal}\n\nExpected result: ${value.expect}`
            : value.goal,
          threadId: thread.id,
        })
        return `Started thread ${thread.id} (${thread.label}). It runs on its own; its report arrives in your inbox.`
      },
    })

    tools.register({
      schema: {
        name: 'list_threads',
        description: 'Read the state of the threads you can act on. Reports arrive in your inbox; use this only to check status. If your remaining work depends on a running thread, set wait_ms and call again until it is no longer working.',
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
        const parentId = caller(options.agentId)
        const scope = value.scope === 'descendants' ? 'descendants' : 'children'
        let entries = await threads.list({ parentId, descendants: scope === 'descendants' })
        const initial = entries.map(entry => `${entry.id}:${entry.state}`).join('|')
        const deadline = Date.now() + (typeof value.wait_ms === 'number' ? value.wait_ms : 0)
        while (entries.some(entry => entry.state === 'working') && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 200))
          entries = await threads.list({ parentId, descendants: scope === 'descendants' })
          if (entries.map(entry => `${entry.id}:${entry.state}`).join('|') !== initial) break
        }
        return entries.length
          ? entries.map(entry => `${entry.id} [${statusOf(entry.state)}] ${entry.label} (parent=${entry.parentId ?? '—'}, depth=${entry.depth})${entry.detail ? ` — ${entry.detail.slice(0, 200)}` : ''}`).join('\n')
          : '(no threads)'
      },
    })

    tools.register({
      schema: {
        name: 'send_thread_message',
        description: 'Send a message to your direct parent or a direct child thread through its inbox. Use kind complete/blocked/failed/request to conclude or block the work you are doing — the project updates the thread state from the message kind.',
        parameters: {
          type: 'object',
          properties: {
            thread_id: { type: 'string', description: 'Direct parent or child thread ID.' },
            message: { type: 'string', description: 'Message to deliver.' },
            kind: {
              type: 'string',
              enum: ['progress', 'request', 'complete', 'blocked', 'failed', 'dispatch'],
              description: 'Default progress. Use dispatch when giving a child new direction.',
            },
          },
          required: ['thread_id', 'message'],
        },
      },
      async execute(input, options) {
        const value = fields(input)
        if (typeof value.thread_id !== 'string' || typeof value.message !== 'string') {
          throw new TypeError('thread_id and message must be strings')
        }
        if (value.kind !== undefined
          && !(MESSAGE_KINDS as readonly unknown[]).includes(value.kind)) {
          throw new TypeError(`kind must be one of ${MESSAGE_KINDS.join(', ')}`)
        }
        const senderId = caller(options.agentId)
        const sender = await threads.get(senderId)
        if (!sender) throw new Error('thread tools require a project thread identity')
        const target = await threads.get(value.thread_id)
        if (!target) throw new Error(`thread not found: ${value.thread_id}`)
        const toChild = target.parentId === senderId
        const toParent = sender.parentId === value.thread_id
        if (!toChild && !toParent) {
          throw new Error('thread messages require a direct parent-child relationship')
        }
        await box.send({
          sender: agentAddress(senderId),
          recipients: [agentAddress(target.id)],
          // 回报与自己这轮的工作放在一起；给子 Thread 的指令出现在它的面板。
          placement: toChild
            ? { kind: 'thread', threadId: target.id }
            : { kind: 'thread', threadId: senderId },
          kind: (value.kind as BoxMessageKind | undefined) ?? 'progress',
          text: value.message,
        })
        return `Message delivered to ${target.id}.`
      },
    })
  },
}
