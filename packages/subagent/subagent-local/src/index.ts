import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { HUMAN_COMMUNICATION_PROMPT, type AgentHandle, type AgentRegistry, type LiveAgent, type LLMAdapter } from '@tnega/agent'
import type { Context } from '@tnega/core'
import { projectEvents, SessionLog, type SessionEvent } from '@tnega/session'
import type { ToolsService } from '@tnega/tools'
import {
  SubagentError,
  SubagentService,
  type SubagentEntry,
  type SubagentAudience,
  type SubagentResultRange,
  type SubagentResultPage,
  type SubagentMode,
  type SubagentScope,
  type SubagentStartRequest,
  type SubagentStatus,
} from '@tnega/subagent'

/**
 * 子代理的 system prompt。读者只有两个：父 Agent，或用户。
 *
 * 默认（agent）写给父 Agent：父 Agent 看不到工具调用与中间对话，只读这一段文字；它是
 * 数据，不是交付物，所以字段化、无客套、不复述任务。
 *
 * 显式指定（user）时它才是给人看的成品，沿用同一份 human 沟通规则。
 */
function childSystemPrompt(audience: SubagentAudience): string {
  const deliverable = audience === 'user'
    ? `Produce a polished deliverable for the user in the requested language and format: the outcome, the evidence behind it, and any unresolved limitation. ${HUMAN_COMMUNICATION_PROMPT}`
    : 'Report to your parent as data, not prose. Use only the fields that carry content: status, result, evidence (paths, commands, outcomes), blockers, next action. Point at files and artifacts instead of copying their contents. When the task asks for another format, follow the task.'
  return `You are a Tnega subagent. Complete the assigned bounded task within its scope and acceptance criteria, and verify what you claim. You share the Workspace; respect assigned edit ownership. Your parent cannot see your tool calls or intermediate conversation. Delegate further only when a separate context is genuinely needed, within configured limits.

Your final answer is the only thing your parent receives, once and automatically. Message the parent only for a blocker that needs a decision, a changed constraint, or a discovery that changes its work; never send routine progress, greetings or acknowledgments. The parent can page through a long answer, so do not compress away decisive detail or repeat the task back.

${deliverable}`
}
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** 送进父 Agent inbox 的结果上限；超出部分靠 read_subagent_result 按页取回。 */
const REPORT_HEAD_CHARS = 1_200

/**
 * 在行边界截断：宁可少几行，也不在半句上断开。
 *
 * 返回的 head 一定附带上限说明与定位符，父 Agent 因此知道还有多少没看到，而不是收到一段
 * 无标记的残缺文本。
 */
function previewOf(output: string, id: string, limit = REPORT_HEAD_CHARS): { head: string; continuation: string } {
  const text = output.trim()
  const chars = Array.from(text)
  if (chars.length <= limit) return { head: text, continuation: '' }
  const head = chars.slice(0, limit).join('')
  const cut = head.lastIndexOf('\n')
  // 以换行符本身为切点：送出的开头正好结束在一行末尾，续读从下一行第一个字符开始。
  const cutChars = cut < 0 ? 0 : Array.from(head.slice(0, cut)).length
  const shown = cutChars >= limit / 2 ? cutChars : limit
  const continuation = `\n[Result: showing ${shown} of ${chars.length} characters. Read the rest with read_subagent_result({"agent_id":"${id}","offset":${shown}}).]`
  return { head: chars.slice(0, shown).join(''), continuation }
}

export interface LocalSubagentConfig {
  cwd: string
  /** Child storage directory; defaults to `<cwd>/.tnega/subagents`. */
  storageRoot?: string
  llm: LLMAdapter
  contextWindow?: number
  maxConcurrent?: number
  maxDepth?: number
  allowShell?: boolean
  allowNetwork?: boolean
  permission?: 'read-only' | 'workspace-write' | 'bypass'
}

function childRoot(workspace: string, storageRoot?: string): string {
  return storageRoot === undefined ? join(workspace, '.tnega', 'subagents') : resolve(storageRoot)
}

function childFile(workspace: string, id: string, storageRoot?: string): string {
  if (!ID_PATTERN.test(id)) throw new SubagentError(`invalid subagent id: ${id}`)
  return join(childRoot(workspace, storageRoot), id, 'session.jsonl')
}

interface StoredChild {
  id: string
  parentId: string
  label: string
  mode: SubagentMode
  audience: SubagentAudience
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

async function readChild(workspace: string, id: string, storageRoot?: string): Promise<StoredChild | undefined> {
  let text: string
  try {
    text = await readFile(childFile(workspace, id, storageRoot), 'utf8')
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
        if (!Array.isArray(payload.toolCalls) || payload.toolCalls.length === 0) lastOutput = payload.content
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
    audience: meta.subagentAudience === 'user' ? 'user' : 'agent',
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
  storageRoot?: string,
): Promise<SubagentEntry[]> {
  let names: string[]
  try {
    names = await readdir(childRoot(resolve(workspace), storageRoot))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const stored = (await Promise.all(names.filter(name => ID_PATTERN.test(name))
    .map(name => readChild(resolve(workspace), name, storageRoot))))
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
        mode: child.mode, audience: child.audience, status, depth: child.depth,
        createdAt: child.createdAt, updatedAt: child.updatedAt,
        ...(child.lastOutput ? {
          lastOutput: Array.from(child.lastOutput).slice(0, 2_000).join(''),
          resultChars: Array.from(child.lastOutput).length,
          resultTruncated: Array.from(child.lastOutput).length > 2_000,
        } : {}) }
    })
}

export async function readSubagentEvents(workspace: string, id: string, storageRoot?: string): Promise<SessionEvent[]> {
  if (!await readChild(resolve(workspace), id, storageRoot)) throw new SubagentError('subagent not found')
  const log = new SessionLog(childFile(resolve(workspace), id, storageRoot))
  await log.init()
  try { return await log.read() } finally { await log.close() }
}

export class LocalSubagentService extends SubagentService {
  private readonly workspace: string
  private readonly storageRoot: string
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
    this.storageRoot = childRoot(this.workspace, config.storageRoot)
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
    if (request.audience !== undefined && request.audience !== 'agent' && request.audience !== 'user') {
      throw new SubagentError('audience must be agent or user')
    }
    const parent = this.agents.get(request.parentId)
    if (!parent) throw new SubagentError('parent Agent is not active')
    const task = request.task.trim()
    if (!task) throw new SubagentError('subagent task must not be empty')
    if (this.running.size >= this.maxConcurrent) throw new SubagentError('subagent concurrency limit reached')
    const depth = (parent.meta.subagentDepth ?? 0) + 1
    if (depth > this.maxDepth) throw new SubagentError('subagent depth limit reached')
    const id = randomUUID()
    const mode = request.mode ?? 'spawn'
    const audience = request.audience ?? 'agent'
    const label = request.label?.trim() || task.slice(0, 64)
    const permission = parent.meta.subagentPermission === 'read-only'
      ? 'read-only'
      : parent.meta.subagentPermission === 'workspace-write' && this.permission === 'bypass'
        ? 'workspace-write' : this.permission
    const createdAt = Date.now()
    const file = childFile(this.workspace, id, this.storageRoot)
    this.running.add(id)
    let handle: AgentHandle | undefined
    try {
      await mkdir(join(this.storageRoot, id, 'artifacts'), { recursive: true })
      handle = await this.agents.create({
        file,
        id,
        sessionId: id,
        llm: this.llm,
        ...(this.contextWindow !== undefined ? { contextWindow: this.contextWindow } : {}),
        system: childSystemPrompt(audience),
        owner: parent.id,
        parentSessionId: parent.id,
        subagentMode: mode,
        subagentAudience: audience,
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
        messages: [{ role: 'user', name: `agent:${parent.id}`, content: `Parent Agent: ${parent.id}\n\nTask: ${task}` }],
      })
      await handle.agent.session.flush()
      void this.settle(id, parent.id, request.reportCompletion !== false)
      return {
        id, parentId: parent.id, label, mode, audience, status: 'running', depth, createdAt, updatedAt: createdAt,
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
      ? await readChild(this.workspace, recipientId, this.storageRoot)
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
    return listStoredSubagents(this.workspace, parentId, scope, this.agents, this.storageRoot)
  }

  override async readResult(parentId: string, id: string, range: SubagentResultRange = {}): Promise<SubagentResultPage> {
    const offset = range.offset ?? 0
    const limit = range.limit ?? 4_000
    if (!Number.isSafeInteger(offset) || offset < 0) throw new SubagentError('offset must be a nonnegative integer')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16_000) throw new SubagentError('limit must be an integer from 1 to 16000')
    const stored = await readChild(this.workspace, id, this.storageRoot)
    if (!stored || stored.parentId !== parentId) throw new SubagentError('result reads require the owning parent')
    const chars = Array.from(stored.lastOutput ?? '')
    const end = Math.min(chars.length, offset + limit)
    const live = this.agents.get(id)
    return { output: chars.slice(offset, end).join(''), totalChars: chars.length,
      nextOffset: end < chars.length ? end : null,
      status: live?.status === 'running' ? 'running' : stored.failed ? 'failed' : live ? 'idle' : 'ready' }
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
    const stored = await readChild(this.workspace, id, this.storageRoot)
    if (!stored) throw new SubagentError('subagent not found')
    const handle = await this.agents.resume({
      file: childFile(this.workspace, id, this.storageRoot), id, sessionId: id, llm: this.llm,
      ...(this.contextWindow !== undefined ? { contextWindow: this.contextWindow } : {}),
      system: childSystemPrompt(stored.audience),
    })
    this.handles.set(id, handle)
    return handle.agent
  }

  private async settle(id: string, parentId: string, reportCompletion = true): Promise<void> {
    try {
      const child = this.agents.get(id)
      if (!child) return
      await child.whenIdle()
      await child.session.flush()
      const events = await child.session.read()
      const end = [...events].reverse().find(event => event.type === 'turn/end')
      const own = [...events].reverse().find(event => event.type === 'assistant/message' && !event.payload.toolCalls?.length)
      const output = own?.type === 'assistant/message' ? own.payload.content : ''
      const reason = end?.type === 'turn/end' ? end.payload.finishReason : 'error'
      const parent = this.agents.get(parentId)
      if (reportCompletion && parent && this.reported.get(id)?.trim() !== output.trim()) {
        // 长结果只送标记过的开头：父 Agent 读到的是"还有多少没看到"，不是被静默截断的正文。
        const { head, continuation } = previewOf(output, id)
        const report = reason === 'stop'
          ? `Subagent ${id} completed: ${head || '(no final text)'}${continuation}`
          : `Subagent ${id} ended (${reason}): ${head || '(no final text)'}${continuation}`
        await parent.steer({ messages: [{ role: 'user', name: `agent:${id}`, content: report }] })
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
