import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { AgentHandle, AgentRegistry, LiveAgent, LLMAdapter } from '@tnega/agent'
import type { Context } from '@tnega/core'
import { projectEvents, SessionLog, type SessionEvent } from '@tnega/session'
import type { ToolsService } from '@tnega/tools'
import {
  SubagentError,
  SubagentService,
  type SubagentEntry,
  type SubagentMode,
  type SubagentScope,
  type SubagentStartRequest,
  type SubagentStatus,
} from '@tnega/subagent'

const CHILD_SYSTEM_PROMPT = `You are a Tnega subagent. Work on the assigned task within its stated scope. Your parent and you communicate through durable inbox messages. Use send_agent_message when you need to report progress or request information. Give a concise final answer with the result and any remaining issue. Do not assume your parent sees your tool calls or intermediate conversation. Spawn another Agent only for an independent bounded task within the configured depth and concurrency limits.`
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface LocalSubagentConfig {
  cwd: string
  llm: LLMAdapter
  contextWindow?: number
  maxConcurrent?: number
  maxDepth?: number
  allowShell?: boolean
  allowNetwork?: boolean
  permission?: 'read-only' | 'workspace-write' | 'bypass'
}

function childRoot(workspace: string): string {
  return join(workspace, '.tnega', 'subagents')
}

function childFile(workspace: string, id: string): string {
  if (!ID_PATTERN.test(id)) throw new SubagentError(`invalid subagent id: ${id}`)
  return join(childRoot(workspace), id, 'session.jsonl')
}

interface StoredChild {
  id: string
  parentId: string
  label: string
  mode: SubagentMode
  depth: number
  createdAt: number
  updatedAt: number
  failed: boolean
  lastOutput?: string
  allowShell: boolean
  allowNetwork: boolean
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

async function readChild(workspace: string, id: string): Promise<StoredChild | undefined> {
  let text: string
  try {
    text = await readFile(childFile(workspace, id), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let meta: Record<string, unknown> | undefined
  let updatedAt = 0
  let failed = false
  let lastOutput: string | undefined
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let event: Record<string, unknown> | undefined
    try { event = recordOf(JSON.parse(line) as unknown) } catch { continue }
    if (!event) continue
    if (typeof event.ts === 'number') updatedAt = Math.max(updatedAt, event.ts)
    if (event.type === 'meta') {
      const payload = recordOf(event.payload)
      if (payload?.kind === 'agent' && payload.subagentMode) meta = payload
    }
    if (event.type === 'turn/end') {
      const payload = recordOf(event.payload)
      if (typeof payload?.finishReason === 'string') failed = payload.finishReason !== 'stop'
    }
    if (event.type === 'assistant/message') {
      const payload = recordOf(event.payload)
      if (typeof payload?.content === 'string' && payload.content.trim()) {
        lastOutput = payload.content.trim().slice(0, 2_000)
      }
    }
  }
  if (!meta || typeof meta.agentId !== 'string' || meta.agentId !== id
    || typeof meta.parentSessionId !== 'string'
    || (meta.subagentMode !== 'spawn' && meta.subagentMode !== 'fork')) return undefined
  return {
    id,
    parentId: meta.parentSessionId,
    label: typeof meta.subagentLabel === 'string' ? meta.subagentLabel : id,
    mode: meta.subagentMode,
    depth: typeof meta.subagentDepth === 'number' ? meta.subagentDepth : 1,
    createdAt: typeof meta.createdAt === 'number' ? meta.createdAt : updatedAt,
    updatedAt,
    failed,
    allowShell: meta.subagentAllowShell === true,
    allowNetwork: meta.subagentAllowNetwork === true,
    ...(lastOutput ? { lastOutput } : {}),
  }
}

function completedPrefix(events: readonly SessionEvent[]): SessionEvent[] {
  let end = -1
  for (let index = 0; index < events.length; index += 1) {
    if (events[index]?.type === 'turn/end') end = index
  }
  return end < 0 ? [] : events.slice(0, end + 1)
}

/** Read the durable catalog without activating any child. */
export async function listStoredSubagents(
  workspace: string,
  parentId: string,
  scope: SubagentScope = 'children',
  agents?: AgentRegistry,
): Promise<SubagentEntry[]> {
  let names: string[]
  try {
    names = await readdir(childRoot(resolve(workspace)))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const stored = (await Promise.all(names.filter(name => ID_PATTERN.test(name))
    .map(name => readChild(resolve(workspace), name))))
    .filter((child): child is StoredChild => child !== undefined)
  const parents = new Set([parentId])
  if (scope === 'descendants') {
    let size = 0
    while (size !== parents.size) {
      size = parents.size
      for (const child of stored) if (parents.has(child.parentId)) parents.add(child.id)
    }
  }
  return stored.filter(child => parents.has(child.parentId))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .map((child): SubagentEntry => {
      const live = agents?.get(child.id)
      const status: SubagentStatus = live?.status === 'running'
        ? 'running'
        : child.failed ? 'failed' : live ? 'idle' : 'ready'
      return { id: child.id, parentId: child.parentId, label: child.label,
        mode: child.mode, status, depth: child.depth,
        createdAt: child.createdAt, updatedAt: child.updatedAt,
        ...(child.lastOutput ? { lastOutput: child.lastOutput } : {}) }
    })
}

export async function readSubagentEvents(workspace: string, id: string): Promise<SessionEvent[]> {
  if (!await readChild(resolve(workspace), id)) throw new SubagentError('subagent not found')
  const log = new SessionLog(childFile(resolve(workspace), id))
  await log.init()
  try { return await log.read() } finally { await log.close() }
}

export class LocalSubagentService extends SubagentService {
  private readonly workspace: string
  private readonly agents: AgentRegistry
  private readonly llm: LLMAdapter
  private readonly contextWindow: number | undefined
  private readonly maxConcurrent: number
  private readonly maxDepth: number
  private readonly allowShell: boolean
  private readonly allowNetwork: boolean
  private readonly permission: 'read-only' | 'workspace-write' | 'bypass'
  private readonly handles = new Map<string, AgentHandle>()
  private readonly activating = new Map<string, Promise<LiveAgent>>()
  private readonly running = new Set<string>()
  private readonly reported = new Map<string, string>()

  constructor(ctx: Context, config: LocalSubagentConfig) {
    super(ctx)
    this.workspace = resolve(config.cwd)
    const agents = ctx.get('agents') as AgentRegistry | undefined
    if (!agents) throw new SubagentError('subagents require the live Agent registry')
    this.agents = agents
    this.llm = config.llm
    this.contextWindow = config.contextWindow
    this.maxConcurrent = config.maxConcurrent ?? 3
    this.maxDepth = config.maxDepth ?? 2
    this.allowShell = config.allowShell === true
    this.allowNetwork = config.allowNetwork === true
    this.permission = config.permission ?? 'read-only'
    if (!Number.isSafeInteger(this.maxConcurrent) || this.maxConcurrent < 1
      || !Number.isSafeInteger(this.maxDepth) || this.maxDepth < 1) {
      throw new SubagentError('subagent limits must be positive integers')
    }
    const tools = ctx.get('tools') as ToolsService
    tools.guard(async request => {
      const id = request.options.agentId
      if (!id || (request.name !== 'shell' && request.name !== 'http_get')) return undefined
      const agent = this.agents.get(id)
      if (agent?.meta.subagentMode === undefined) return undefined
      const allowed = request.options.approvedElevation === true || (request.name === 'shell'
        ? agent.meta.subagentAllowShell === true
        : agent.meta.subagentAllowNetwork === true)
      return allowed ? undefined : `${request.name} was not authorized when this subagent was created`
    })
  }

  override async start(request: SubagentStartRequest): Promise<SubagentEntry> {
    const parent = this.agents.get(request.parentId)
    if (!parent) throw new SubagentError('parent Agent is not active')
    const task = request.task.trim()
    if (!task) throw new SubagentError('subagent task must not be empty')
    if (this.running.size >= this.maxConcurrent) throw new SubagentError('subagent concurrency limit reached')
    const depth = (parent.meta.subagentDepth ?? 0) + 1
    if (depth > this.maxDepth) throw new SubagentError('subagent depth limit reached')
    const id = randomUUID()
    const mode = request.mode ?? 'spawn'
    const label = request.label?.trim() || task.slice(0, 64)
    const permission = parent.meta.subagentPermission === 'read-only'
      ? 'read-only'
      : parent.meta.subagentPermission === 'workspace-write' && this.permission === 'bypass'
        ? 'workspace-write' : this.permission
    const createdAt = Date.now()
    const file = childFile(this.workspace, id)
    this.running.add(id)
    let handle: AgentHandle | undefined
    try {
      await mkdir(join(childRoot(this.workspace), id, 'artifacts'), { recursive: true })
      handle = await this.agents.create({
        file,
        id,
        sessionId: id,
        llm: this.llm,
        ...(this.contextWindow !== undefined ? { contextWindow: this.contextWindow } : {}),
        system: CHILD_SYSTEM_PROMPT,
        owner: parent.id,
        parentSessionId: parent.id,
        subagentMode: mode,
        subagentLabel: label,
        subagentDepth: depth,
        subagentAllowShell: this.allowShell && parent.meta.subagentAllowShell !== false,
        subagentAllowNetwork: this.allowNetwork && parent.meta.subagentAllowNetwork !== false,
        subagentPermission: permission,
        createdAt,
        ...(parent.agentType ? { agentType: parent.agentType } : {}),
      })
      if (mode === 'fork') {
        const prefix = completedPrefix(await parent.session.read())
        const messages = projectEvents(prefix).filter(message => message.role !== 'system')
        if (messages.length) await handle.agent.session.append('checkpoint', { messages })
      }
      this.handles.set(id, handle)
      await handle.agent.followup({
        text: `Parent Agent: ${parent.id}\n\nTask: ${task}`,
      })
      await handle.agent.session.flush()
      void this.settle(id, parent.id)
      return {
        id, parentId: parent.id, label, mode, status: 'running', depth, createdAt, updatedAt: createdAt,
      }
    } catch (error) {
      this.running.delete(id)
      this.handles.delete(id)
      await handle?.dispose().catch(() => undefined)
      throw error
    }
  }

  override async send(senderId: string, recipientId: string, message: string): Promise<void> {
    const sender = this.agents.get(senderId)
    if (!sender) throw new SubagentError('sending Agent is not active')
    const content = message.trim()
    if (!content) throw new SubagentError('agent message must not be empty')
    const stored = ID_PATTERN.test(recipientId)
      ? await readChild(this.workspace, recipientId)
      : undefined
    const target = this.agents.get(recipientId)
    const parentToChild = stored?.parentId === senderId
    const childToParent = sender.parentSessionId === recipientId && target !== undefined
    if (!parentToChild && !childToParent) {
      throw new SubagentError('agent messages require a direct parent-child relationship')
    }
    if (parentToChild && !this.running.has(recipientId)
      && this.running.size >= this.maxConcurrent) {
      throw new SubagentError('subagent concurrency limit reached')
    }
    const recipient = target ?? await this.activate(recipientId)
    const input = { messages: [{ role: 'user' as const, name: `agent:${senderId}`, content }] }
    if (recipient.status === 'running') await recipient.steer(input)
    else {
      await recipient.followup(input)
      if (parentToChild) {
        this.running.add(recipientId)
        void this.settle(recipientId, senderId)
      }
    }
    if (childToParent) this.reported.set(senderId, content)
  }

  override async list(parentId: string, scope: SubagentScope = 'children'): Promise<SubagentEntry[]> {
    return listStoredSubagents(this.workspace, parentId, scope, this.agents)
  }

  async dispose(): Promise<void> {
    for (const handle of [...this.handles.values()].reverse()) {
      await handle.dispose().catch(() => undefined)
    }
    this.handles.clear()
    this.running.clear()
  }

  private async activate(id: string): Promise<LiveAgent> {
    const pending = this.activating.get(id)
    if (pending) return pending
    const activation = this.resumeChild(id)
    this.activating.set(id, activation)
    try { return await activation } finally { this.activating.delete(id) }
  }

  private async resumeChild(id: string): Promise<LiveAgent> {
    const stored = await readChild(this.workspace, id)
    if (!stored) throw new SubagentError('subagent not found')
    const handle = await this.agents.resume({
      file: childFile(this.workspace, id), id, sessionId: id, llm: this.llm,
      ...(this.contextWindow !== undefined ? { contextWindow: this.contextWindow } : {}),
      system: CHILD_SYSTEM_PROMPT,
    })
    this.handles.set(id, handle)
    return handle.agent
  }

  private async settle(id: string, parentId: string): Promise<void> {
    try {
      const child = this.agents.get(id)
      if (!child) return
      await child.whenIdle()
      await child.session.flush()
      const events = await child.session.read()
      const end = [...events].reverse().find(event => event.type === 'turn/end')
      const own = [...events].reverse().find(event => event.type === 'assistant/message')
      const output = own?.type === 'assistant/message' ? own.payload.content.trim() : ''
      const reason = end?.type === 'turn/end' ? end.payload.finishReason : 'error'
      const parent = this.agents.get(parentId)
      if (parent && this.reported.get(id)?.trim() !== output) {
        const report = reason === 'stop'
          ? `Subagent ${id} completed: ${output || '(no final text)'}`
          : `Subagent ${id} ended (${reason}): ${output || '(no final text)'}`
        await parent.steer({ messages: [{ role: 'user', name: `agent:${id}`, content: report.slice(0, 4_000) }] })
      }
    } catch {
      // The child Session remains available for inspection and later follow-up.
    } finally {
      this.running.delete(id)
      this.reported.delete(id)
    }
  }
}

export const subagentLocal = {
  name: 'subagent-local',
  inject: ['agents'],
  apply(ctx: Context, config: LocalSubagentConfig): void {
    const service = new LocalSubagentService(ctx, config)
    ctx.fiber.effect(() => () => service.dispose(), 'dispose subagents')
  },
}
