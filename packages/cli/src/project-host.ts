import { installBuiltinSkills, renderSkillIndex, skillTools } from '@tnega/coding-agent'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { agents, continuationNudge, systemPrompt, type AgentRegistry, type LiveAgent, type LLMAdapter } from '@tnega/agent'
import { workspacePrompt } from './workspace-prompt.js'
import { artifactLocal } from '@tnega/artifact-local'
import type { ArtifactStore } from '@tnega/artifact-store'
import { blackboardLocal } from '@tnega/blackboard-local'
import type { BlackboardService, FactRecord } from '@tnega/blackboard'
import {
  USER_ADDRESS,
  agentAddress,
  type BoxEnvelope,
  type BoxService,
} from '@tnega/box'
import { boxBlackboard } from '@tnega/box-blackboard'
import { Context } from '@tnega/core'
import { runSummary } from '@tnega/run-summary'
import { ptcRuntimeQuickjs, type PtcRuntimeQuickjsConfig } from '@tnega/ptc-runtime-quickjs'
import { projectSessionRoot, workspaceProjectStateRoot } from './state-storage.js'
import { toolPtc } from '@tnega/tool-ptc'
import { jobsLocal } from '@tnega/jobs-local'
import { toolJobs } from '@tnega/tool-jobs'
import { mountApprovalReview, reviewAutomaticApproval } from './approval.js'
import type { SystemConfig } from './config.js'
import { projectLoop } from '@tnega/project-loop'
import { projectLocal } from '@tnega/project-local'
import type { ProjectRecord, ProjectsService } from '@tnega/project'
import { searchRipgrep } from '@tnega/search-ripgrep'
import { canonicalPath, resolveSandboxPolicy } from '@tnega/sandbox'
import { sandboxLocal } from '@tnega/sandbox-local'
import { sandboxedExecution } from '@tnega/execution-sandbox'
import { SessionLog, foldUsage, type SessionEvent } from '@tnega/session'
import { RoutineRunner, registerRoutineTools } from './project-routines.js'
import { foldApprovalMode } from '@tnega/approval-review'

/** How many of the user's latest room messages a thread's reviewer reads as authorization. */
const ROOM_EVIDENCE_MESSAGES = 8
import { spillLocal } from '@tnega/spill-local'
import { COORDINATOR_SYSTEM_PROMPT, THREAD_SYSTEM_PROMPT, threadLocal } from '@tnega/thread-local'
import type { ThreadRecord, ThreadService } from '@tnega/thread'
import { toolBlackboard } from '@tnega/tool-blackboard'
import { toolBox } from '@tnega/tool-box'
import { toolSpill } from '@tnega/tool-spill'
import { toolOffice } from '@tnega/tool-office'
import { toolSearch } from '@tnega/tool-search'
import { toolThread } from '@tnega/tool-thread'
import { builtinTools, tools, type BuiltinToolsConfig, type ToolsService } from '@tnega/tools'
import { ApprovalBroker, permissionGuard, type PermissionMode } from './permissions.js'
import { mountThreadApprovals } from './thread-approval.js'

export interface ProjectHostOptions {
  ptcRuntime?: PtcRuntimeQuickjsConfig
  systemConfig?: SystemConfig
  /** Tools operate in this workspace; Project runtime state is stored in Tnega home. */
  workspace: string
  llm: LLMAdapter
  contextWindow?: number
  /** Project 授权：所有 Thread 的上限。 */
  permission: PermissionMode
  approvals: ApprovalBroker
  /** 传给 Thread 的内置工具配置；`false` 表示不挂文件与 shell 工具。 */
  builtinTools?: BuiltinToolsConfig | false
  maxDepth?: number
  maxChildren?: number
}

/** 一个打开着的 Project：它的作用域与其中的服务。 */
export interface OpenProject {
  record: ProjectRecord
  ctx: Context
  box: BoxService
  threads: ThreadService
  blackboard: BlackboardService
  artifacts: ArtifactStore
  registry: AgentRegistry
  tools: ToolsService
  routines: RoutineRunner
  directory: string
}

/** What one thread (or the whole project) has consumed. */
export interface UsageTotals {
  responses: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  /** Time spent inside turns, summed from turn start to turn end. */
  activeMs: number
  turns: number
}

export interface ProjectUsage {
  total: UsageTotals
  /** Totals for events at or after `since`, when it was asked for. */
  since?: UsageTotals
  byThread: Array<UsageTotals & { threadId: string; lastActiveAt?: number }>
}

function emptyTotals(): UsageTotals {
  return { responses: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, activeMs: 0, turns: 0 }
}

function addTotals(into: UsageTotals, from: UsageTotals): void {
  into.responses += from.responses
  into.promptTokens += from.promptTokens
  into.completionTokens += from.completionTokens
  into.cachedTokens += from.cachedTokens
  into.activeMs += from.activeMs
  into.turns += from.turns
}

/** Tokens from the usage each response reported; active time from turn boundaries. */
export function sessionTotals(events: readonly SessionEvent[]): UsageTotals {
  const metrics = foldUsage(events)
  let activeMs = 0
  let turns = 0
  let started: number | undefined
  for (const event of events) {
    if (event.type === 'turn/start') started = event.ts
    else if (event.type === 'turn/end' && started !== undefined) {
      activeMs += Math.max(0, event.ts - started)
      turns += 1
      started = undefined
    }
  }
  return {
    responses: metrics.responses,
    promptTokens: metrics.promptTokens,
    completionTokens: metrics.completionTokens,
    cachedTokens: metrics.cachedTokens,
    activeMs,
    turns,
  }
}

export interface ProjectSnapshot {
  project: ProjectRecord
  coordinatorId: string
  /** 消息流游标：下次带 `after` 拉取就能只补新消息。 */
  cursor: number
  threads: ThreadRecord[]
  /** 主对话时间线：用户发言、协调者发言与 Thread 卡片。 */
  messages: BoxEnvelope[]
  /** 发给 coordinator 的子 Agent inbox 信封；前端将其归入对应的 Subagent 卡片。 */
  inboxMessages: BoxEnvelope[]
  memory: FactRecord[]
  library: { artifacts: FactRecord[]; resources: FactRecord[] }
  routines: FactRecord[]
}

export interface ProjectThreadDetail {
  thread: ThreadRecord
  events: SessionEvent[]
}

/** workspace 级的 Project 目录作用域：只装 Blackboard 与 Project 身份。 */
interface IndexScope {
  ctx: Context
  projects: ProjectsService
}

/**
 * Project Host：把 Project 作用域装配起来，并把它的读写整理成 Web 需要的形状。
 *
 * 它只做组合：
 *
 * - **挑 Provider**。Blackboard、Artifact Store、Box、Thread 各挂一个本地实现；模型、工具
 *   与资源由宿主按 Project 授权组合。这里没有协作业务状态 —— 事实都在 Blackboard 与各
 *   Agent 的 Session 里。
 * - **索引与作用域分开**。Project 目录（`project` 记录）挂在 workspace 级的 Blackboard 上，
 *   每个 Project 的共享事实挂在它自己的 Blackboard 上；两处都不复制对方的内容。
 * - **一个 Project 一个作用域**。同一 Project 只挂一次；重启进程后重新装配，未确认的消息
 *   由 Project Loop 重投。
 * - **授权按 Thread 收窄**。工具守卫读取该 Thread 记录的权限，没有记录的调用按最窄处理。
 */
export class ProjectHost {
  private readonly workspace: string
  private readonly tnegaRoot: string
  private readonly options: ProjectHostOptions
  private readonly open = new Map<string, Promise<OpenProject>>()
  private readonly permissions = new Map<string, PermissionMode>()
  private indexScope: Promise<IndexScope> | undefined

  constructor(options: ProjectHostOptions) {
    if (!options?.workspace || typeof options.workspace !== 'string') {
      throw new Error('project host requires a workspace')
    }
    this.options = options
    this.workspace = resolve(options.workspace)
    this.tnegaRoot = workspaceProjectStateRoot(this.workspace)
  }

  /** 建 Project：只建身份与目录，不拉起 Agent。 */
  async create(input: { name: string; goal?: string }): Promise<ProjectRecord> {
    const projects = await this.projects()
    return await projects.create(input)
  }

  async list(): Promise<ProjectRecord[]> {
    return await (await this.projects()).list()
  }

  async get(id: string): Promise<ProjectRecord | undefined> {
    return await (await this.projects()).get(id)
  }

  async update(id: string, patch: { archived?: boolean }, author = 'user'): Promise<ProjectRecord> {
    return await (await this.projects()).update(id, patch, author)
  }

  async delete(id: string, author = 'user'): Promise<void> {
    const mounted = this.open.get(id)
    if (mounted) {
      this.open.delete(id)
      await mounted.then(project => project.ctx.fiber.dispose()).catch(() => undefined)
    }
    await (await this.projects()).delete(id, author)
    await rm(projectSessionRoot(this.workspace, id), { recursive: true, force: true })
    await rm(join(this.workspace, '.tnega', 'projects', id), { recursive: true, force: true })
  }

  /** 打开（或复用已打开的）Project 作用域，并保证协调者 Thread 存在。 */
  async mount(projectId: string): Promise<OpenProject> {
    const existing = this.open.get(projectId)
    if (existing) return await existing
    const record = await this.get(projectId)
    if (!record) throw new Error(`project not found: ${projectId}`)
    const mounting = this.assemble(record)
    this.open.set(projectId, mounting)
    try {
      return await mounting
    } catch (error) {
      this.open.delete(projectId)
      throw error
    }
  }

  async snapshot(projectId: string): Promise<ProjectSnapshot> {
    const project = await this.mount(projectId)
    const facts = await project.blackboard.list('message')
    const envelopes = facts.map(fact => fact.data as BoxEnvelope)
    const messages = envelopes.filter(envelope => envelope.placement.kind === 'main')
    const inboxMessages = envelopes.filter(envelope => envelope.sender.kind === 'agent'
      && envelope.sender.id !== project.record.coordinatorId
      && envelope.recipients.some(recipient => recipient.kind === 'agent'
        && recipient.id === project.record.coordinatorId))
    return {
      project: project.record,
      coordinatorId: project.record.coordinatorId,
      cursor: facts.reduce((max, fact) => Math.max(max, fact.seq), 0),
      threads: await project.threads.list(),
      messages,
      inboxMessages,
      memory: await project.blackboard.list('memory'),
      library: {
        artifacts: await project.blackboard.list('artifact'),
        resources: await project.blackboard.list('resource'),
      },
      routines: (await project.blackboard.list('routine')).filter(fact => !fact.deleted),
    }
  }

  /** 主对话发言：送协调者 inbox，UI 立刻显示已接收，不等模型回复。 */
  async sendUserMessage(projectId: string, text: string, replyTo?: string): Promise<BoxEnvelope> {
    const project = await this.mount(projectId)
    // 回复只认主对话里真实存在的消息；找不到就当作普通发言，而不是挂一个悬空引用。
    const source = replyTo
      ? (await project.box.timeline()).find(envelope => envelope.messageId === replyTo)
      : undefined
    return await project.box.send({
      sender: USER_ADDRESS,
      recipients: [agentAddress(project.record.coordinatorId)],
      placement: { kind: 'main' },
      kind: 'user-message',
      text,
      ...(source ? { causationId: source.messageId } : {}),
    })
  }

  /**
   * 直接给某个 Thread 留言。协调者另收一条可追溯的活动通知，而不是把用户的话当成自己的
   * 指令塞进协调者的 inbox；通知只进它的上下文、不唤醒它，也不出现在主对话里。
   */
  async sendThreadMessage(projectId: string, threadId: string, text: string): Promise<BoxEnvelope> {
    const project = await this.mount(projectId)
    const thread = await project.threads.get(threadId)
    if (!thread) throw new Error(`thread not found: ${threadId}`)
    const envelope = await project.box.send({
      sender: USER_ADDRESS,
      recipients: [agentAddress(threadId)],
      placement: { kind: 'thread', threadId },
      kind: 'user-thread',
      text,
    })
    if (threadId !== project.record.coordinatorId) {
      await project.box.send({
        sender: USER_ADDRESS,
        recipients: [agentAddress(project.record.coordinatorId)],
        placement: { kind: 'thread', threadId },
        kind: 'notice',
        text: `The user wrote in thread "${thread.label}" (${threadId}): ${text}`,
        threadId,
        causationId: envelope.messageId,
      })
    }
    return envelope
  }

  /** 订阅一个 Project 的变化：先补 `after` 之后的信封，再持续推送事实与授权请求。 */
  async watch(
    projectId: string,
    options: { after?: number; send: (event: Record<string, unknown>) => void },
  ): Promise<() => void> {
    const project = await this.mount(projectId)
    const disposers: Array<() => void> = []
    const { after, send } = options
    if (after !== undefined) {
      for (const fact of await project.blackboard.list('message', { after })) {
        send({ type: 'message', seq: fact.seq, envelope: fact.data })
      }
    }
    // 活的输出：Agent 正在生成的正文按块推下去，状态变化也推 —— 否则界面只能在整轮结束、
    // 回复发布之后才知道发生了什么，看起来就是「没有响应」。
    const attached = new Set<string>()
    const attach = (agentId: string, agent: LiveAgent): void => {
      if (attached.has(agentId)) return
      attached.add(agentId)
      agent.ctx.on('session/event', (event: SessionEvent) => {
        if (event.type !== 'assistant/chunk') return
        const payload = event.payload
        if (typeof payload.content !== 'string' || !payload.content) return
        send({ type: 'chunk', agentId, text: payload.content })
      })
    }
    for (const agent of project.registry.list()) attach(agent.id, agent)
    disposers.push(project.ctx.on('agent/created', (event: { id: string; agent: LiveAgent }) => {
      attach(event.id, event.agent)
    }))
    disposers.push(project.ctx.on('agent/status', (event: { id: string; status: string }) => {
      send({ type: 'agent-status', agentId: event.id, status: event.status })
    }))
    disposers.push(project.ctx.on('blackboard/commit', (event: { records: readonly FactRecord[] }) => {
      for (const record of event.records) {
        // 消息用和补齐时一样的帧推下去：订阅方只认一种消息形状，不会「补齐有、实时没有」。
        if (record.kind === 'message') {
          send({ type: 'message', seq: record.seq, envelope: record.data })
          continue
        }
        send({
          type: 'commit',
          kind: record.kind,
          id: record.id,
          seq: record.seq,
          deleted: record.deleted,
          data: record.data,
          // 谁写的、第几版：产物卡片按作者挂到 Thread 上，编辑记忆要带版本号。
          author: record.author,
          version: record.version,
          updatedAt: record.updatedAt,
          source: record.source,
        })
      }
    }))
    disposers.push(this.options.approvals.attach(projectId, event => send(event)))
    const heartbeat = setInterval(() => send({ type: 'heartbeat', at: Date.now() }), 15_000)
    heartbeat.unref?.()
    return () => {
      clearInterval(heartbeat)
      for (const dispose of disposers.reverse()) dispose()
    }
  }

  /** Thread 详情：该 Agent 的 Session 事件与它当前的记录。 */
  async thread(projectId: string, threadId: string): Promise<ProjectThreadDetail> {
    const project = await this.mount(projectId)
    const thread = await project.threads.get(threadId)
    if (!thread) throw new Error(`thread not found: ${threadId}`)
    return { thread, events: await this.readSession(project, threadId) }
  }

  /**
   * 读一份已进入 Library 的产物。只认 Blackboard 里登记过的哈希：Library 里看不到的
   * 内容，HTTP 面也拿不到。
   */
  async artifact(projectId: string, hash: string): Promise<{ mediaType: string; content: Uint8Array } | undefined> {
    const project = await this.mount(projectId)
    const fact = await project.blackboard.read('artifact', hash)
    if (!fact || fact.deleted) return undefined
    const data = fact.data as { mediaType?: unknown }
    const mediaType = typeof data.mediaType === 'string' ? data.mediaType : 'text/plain'
    return { mediaType, content: await project.artifacts.get(hash) }
  }

  /** 停下一个 Thread 正在跑的工作；它之后仍能接收新的要求。 */
  async stopThread(projectId: string, threadId: string): Promise<boolean> {
    const project = await this.mount(projectId)
    const agent = project.registry.get(threadId)
    if (!agent || agent.status !== 'running') return false
    agent.cancel({ type: 'user' })
    return true
  }

  /** 停下这个 Project 里所有正在跑的 Agent。 */
  async stop(projectId: string): Promise<number> {
    const project = await this.mount(projectId)
    let stopped = 0
    for (const agent of project.registry.list()) {
      if (agent.status !== 'running') continue
      agent.cancel({ type: 'user' })
      stopped += 1
    }
    return stopped
  }

  /** 人收下（或重新打开）一个 Thread。重新打开回到空闲，等下一条消息。 */
  async setThreadResolved(projectId: string, threadId: string, resolved: boolean): Promise<ThreadRecord> {
    const project = await this.mount(projectId)
    const thread = await project.threads.get(threadId)
    if (!thread || thread.id === project.record.coordinatorId) throw new Error(`thread not found: ${threadId}`)
    if (resolved && thread.state === 'working') {
      project.registry.get(threadId)?.cancel({ type: 'user' })
    }
    return await project.threads.setState(threadId, resolved ? 'resolved' : 'idle')
  }

  /** 每个 Thread 与整个 Project 的消耗；`since` 给出时另算这之后的部分（比如「今天」）。 */
  async usage(projectId: string, since?: number): Promise<ProjectUsage> {
    const project = await this.mount(projectId)
    const total = emptyTotals()
    const recent = emptyTotals()
    const byThread: ProjectUsage['byThread'] = []
    for (const thread of await project.threads.list()) {
      const events = await this.readSession(project, thread.id)
      const totals = sessionTotals(events)
      addTotals(total, totals)
      if (since !== undefined) addTotals(recent, sessionTotals(events.filter(event => event.ts >= since)))
      const last = events.at(-1)
      byThread.push({ threadId: thread.id, ...totals, ...(last ? { lastActiveAt: last.ts } : {}) })
    }
    return { total, byThread, ...(since !== undefined ? { since: recent } : {}) }
  }

  async createRoutine(projectId: string, input: { title: unknown; prompt: unknown; schedule: unknown; enabled?: unknown }): Promise<FactRecord> {
    return await (await this.mount(projectId)).routines.create(input, 'user')
  }

  async updateRoutine(projectId: string, routineId: string, patch: Record<string, unknown>): Promise<FactRecord> {
    return await (await this.mount(projectId)).routines.update(routineId, patch, 'user')
  }

  async runRoutine(projectId: string, routineId: string): Promise<FactRecord> {
    return await (await this.mount(projectId)).routines.run(routineId, 'user')
  }

  /** 记忆版本：谁在什么时候写了什么，用来追溯来源。 */
  async memoryHistory(projectId: string, memoryId: string): Promise<FactRecord[]> {
    const project = await this.mount(projectId)
    return await project.blackboard.history('memory', memoryId)
  }

  /**
   * 写入、修改或删除一条项目记忆。
   *
   * 用户编辑走的是和 Agent 完全相同的条件提交：改一条已存在的记忆必须带上读到的版本号，
   * 版本不符就带着当前记录失败，由调用界面重新读取后再提交 —— 不会覆盖掉刚写进去的内容。
   */
  async writeMemory(
    projectId: string,
    input: { id?: string; text: string; tags?: string[]; expectedVersion?: number | null; deleted?: boolean },
  ): Promise<FactRecord> {
    const project = await this.mount(projectId)
    const id = input.id ?? randomUUID()
    const data: Record<string, unknown> = { text: input.text }
    if (input.tags?.length) data.tags = input.tags
    const expected = input.id === undefined ? null : input.expectedVersion
    return await project.blackboard.commit({
      kind: 'memory',
      id,
      data,
      author: 'user',
      ...(expected !== undefined ? { expectedVersion: expected } : {}),
      ...(input.deleted === true ? { deleted: true } : {}),
    })
  }

  /** 授权决定：把某个待批准的越权调用放行或拒绝。 */
  decide(projectId: string, approvalId: string, allow: boolean): boolean {
    return this.options.approvals.decide(approvalId, projectId, allow)
  }

  async dispose(): Promise<void> {
    const pending = [...this.open.values()]
    this.open.clear()
    for (const project of pending) {
      await project.then(entry => entry.ctx.fiber.dispose()).catch(() => undefined)
    }
    const index = this.indexScope
    this.indexScope = undefined
    if (index) await index.then(entry => entry.ctx.fiber.dispose()).catch(() => undefined)
  }

  private async projects(): Promise<ProjectsService> {
    this.indexScope ??= (async () => {
      const ctx = new Context()
      await ctx.plugin(blackboardLocal, { root: join(this.tnegaRoot, 'blackboard') })
      await ctx.plugin(projectLocal, { root: join(this.tnegaRoot, 'projects') })
      return { ctx, projects: ctx.get('projects') as ProjectsService }
    })()
    return (await this.indexScope).projects
  }

  private async assemble(record: ProjectRecord): Promise<OpenProject> {
    const directory = join(this.tnegaRoot, 'projects', record.id)
    const ctx = new Context()
    await ctx.plugin(tools)
    await ctx.plugin(systemPrompt)
    await ctx.plugin(workspacePrompt, { workspace: this.workspace })
    await ctx.plugin(blackboardLocal, { root: join(directory, 'blackboard') })
    await ctx.plugin(artifactLocal, { root: join(this.workspace, '.tnega', 'projects', record.id, 'artifacts') })
    await ctx.plugin(boxBlackboard, { projectId: record.id })
    await ctx.plugin(agents)
    await ctx.plugin(runSummary)
    if (this.options.builtinTools !== false) await installBuiltinSkills()
    const skillsPrompt = this.options.builtinTools !== false ? await renderSkillIndex(this.workspace) : ''
    await ctx.plugin(threadLocal, {
      coordinatorPrompt: `${COORDINATOR_SYSTEM_PROMPT}\n\n${skillsPrompt}`,
      threadPrompt: `${THREAD_SYSTEM_PROMPT}\n\n${skillsPrompt}`,
      projectId: record.id,
      root: directory,
      sessionRoot: projectSessionRoot(this.workspace, record.id),
      llm: this.options.llm,
      ...(this.options.contextWindow !== undefined
        ? { contextWindow: this.options.contextWindow }
        : {}),
      permission: this.options.permission,
      ...(this.options.maxDepth !== undefined ? { maxDepth: this.options.maxDepth } : {}),
      ...(this.options.maxChildren !== undefined ? { maxChildren: this.options.maxChildren } : {}),
    })

    const config = this.options.builtinTools
    if (config !== false) {
      const cwd = this.workspace
      // 沙箱缝：Project 的授权是它的所有 Thread 的上限，所以策略取 Project 的
      // permission；宿主上没有可用后端时 shell 会 fail closed。
      await ctx.plugin(sandboxLocal, { workspaceRoot: canonicalPath(cwd) })
      await ctx.plugin(builtinTools, {
        cwd,
        ...(config ?? {}),
        execution: sandboxedExecution(ctx, {
          policy: resolveSandboxPolicy({
            mode: this.options.permission,
            workspaceRoot: canonicalPath(cwd),
            sessionId: record.id,
          }),
        }),
      })
      // 搜索与溢出是两条能力缝：组合层挑 Provider，模型可见的工具只认识 ctx.search
      // 与 ctx.spillStore。
      await ctx.plugin(searchRipgrep, { cwd })
      await ctx.plugin(toolSearch, { cwd })
      await ctx.plugin(spillLocal, { cwd })
      await ctx.plugin(toolSpill)
      await ctx.plugin(toolOffice, { cwd })
      await ctx.plugin(skillTools, { cwd })
    }

    await ctx.plugin(toolBlackboard, { cwd: this.workspace })
    await ctx.plugin(toolThread)
    await ctx.plugin(toolBox)

    const registry = ctx.get('agents') as AgentRegistry
    await ctx.plugin(jobsLocal)
    await ctx.plugin(toolJobs, { resolveSession: (agentId?: string) => registry.get(agentId ?? record.coordinatorId)?.session })
    await ctx.plugin(continuationNudge)
    const threads = ctx.get('threads') as ThreadService
    const toolService = ctx.get('tools') as ToolsService
    // Review first with trusted room evidence; an undecided call waits on its
    // direct parent, which can decide or forward the exact call to the user.
    const isThread = (agentId: string | undefined): boolean => agentId !== undefined && agentId !== record.coordinatorId
    const systemConfig = this.options.systemConfig ?? {}
    await mountApprovalReview(ctx, {
      config: systemConfig, workspace: this.workspace, adapter: this.options.llm,
      session: agentId => agentId ? registry.get(agentId)?.session : registry.get(record.coordinatorId)?.session,
      mode: async agentId => {
        if (isThread(agentId)) return 'auto'
        const session = registry.get(record.coordinatorId)?.session
        return (session ? foldApprovalMode(await session.read()) : undefined) ?? systemConfig.approvalReview?.defaultMode ?? 'manual'
      },
      evidenceMessages: async (messages, agentId) => {
        const envelopes = await ctx.box.timeline()
        const humanIds = new Set(envelopes.filter(envelope => envelope.sender.kind === 'user').map(envelope => `box:${envelope.messageId}`))
        const own = messages.map(message => {
          if (message.role !== 'user' || !message.name || !humanIds.has(message.name)) return message
          return { role: message.role, content: message.content }
        })
        if (!isThread(agentId)) return own
        const room = envelopes
          .filter(envelope => envelope.sender.kind === 'user' && envelope.placement.kind === 'main' && envelope.kind === 'user-message')
          .slice(-ROOM_EVIDENCE_MESSAGES)
          .map(envelope => ({ role: 'user' as const, content: envelope.text }))
        return [...room, ...own]
      },
    })
    const permission: PermissionMode = this.options.permission
    const track = (entry: ThreadRecord): void => {
      this.permissions.set(entry.id, entry.permission)
    }
    await threads.ensureRoot(record)
    const threadApprovals = mountThreadApprovals(ctx, { projectId: record.id, approvals: this.options.approvals })
    for (const thread of await threads.list()) track(thread)
    ctx.on('thread/spawned', (event: { thread: ThreadRecord }) => track(event.thread))
    toolService.guard(permissionGuard(permission, record.id, this.options.approvals, {
      workspace: this.workspace,
      review: request => reviewAutomaticApproval(ctx, request),
      // 没有记录的 Agent（例如 Thread 内部再起的普通 Subagent）按最窄处理。
      agentMode: agentId => this.permissions.get(agentId) ?? 'read-only',
      delegated: isThread,
      delegateApproval: (request, review) => threadApprovals.request(request, review),
    }))

    await ctx.plugin(projectLoop, { projectId: record.id })
    const routines = new RoutineRunner({
      blackboard: ctx.get('blackboard') as BlackboardService,
      threads,
      box: ctx.get('box') as BoxService,
      coordinatorId: record.coordinatorId,
    })
    registerRoutineTools(toolService, routines)
    routines.start()
    ctx.fiber.effect(() => () => routines.dispose(), 'stop routines')
    await ctx.plugin(ptcRuntimeQuickjs, this.options.ptcRuntime)
    await ctx.plugin(toolPtc, {
      mode: this.options.systemConfig?.codeMode ? 'ptc' : 'native',
      resolveSession: (agentId?: string) => registry.get(agentId ?? record.coordinatorId)?.session,
    })

    return {
      record,
      ctx,
      box: ctx.get('box') as BoxService,
      threads,
      blackboard: ctx.get('blackboard') as BlackboardService,
      artifacts: ctx.get('artifacts') as ArtifactStore,
      registry,
      tools: toolService,
      routines,
      directory,
    }
  }

  /**
   * 读某个 Thread 的 Session；不激活 Agent，只看已经落盘的事实。
   *
   * 先确认文件存在再打开：`SessionLog` 第一次读不存在的文件时会把它建出来，于是「在 UI
   * 里看过一眼」会在磁盘上留下一个没有 Agent 身份的假 Session。
   */
  private async readSession(project: OpenProject, threadId: string): Promise<SessionEvent[]> {
    const live = project.registry.get(threadId)
    if (live) return await live.session.read()
    const file = project.threads.sessionFile(threadId)
    if (!existsSync(file)) return []
    let log: SessionLog | undefined
    try {
      log = new SessionLog(file)
      await log.init()
      return await log.read()
    } catch {
      // 还没跑过的 Thread 没有历史，不是错误。
      return []
    } finally {
      await log?.close().catch(() => undefined)
    }
  }
}
