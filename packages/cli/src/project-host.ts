import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { agents, type AgentRegistry, type LiveAgent, type LLMAdapter } from '@tnega/agent'
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
import { projectLoop } from '@tnega/project-loop'
import { projectLocal } from '@tnega/project-local'
import type { ProjectRecord, ProjectsService } from '@tnega/project'
import { searchRipgrep } from '@tnega/search-ripgrep'
import { SessionLog, type SessionEvent } from '@tnega/session'
import { spillLocal } from '@tnega/spill-local'
import { threadLocal } from '@tnega/thread-local'
import type { ThreadPermission, ThreadRecord, ThreadService } from '@tnega/thread'
import { toolBlackboard } from '@tnega/tool-blackboard'
import { toolBox } from '@tnega/tool-box'
import { toolSpill } from '@tnega/tool-spill'
import { toolSearch } from '@tnega/tool-search'
import { toolThread } from '@tnega/tool-thread'
import { builtinTools, tools, type BuiltinToolsConfig, type ToolsService } from '@tnega/tools'
import { ApprovalBroker, permissionGuard, type PermissionMode } from './permissions.js'

export interface ProjectHostOptions {
  /** Project 目录集合与工具工作目录的基准：`<workspace>/.tnega/projects/<id>`。 */
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
  directory: string
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
    this.tnegaRoot = join(this.workspace, '.tnega')
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
    }
  }

  /** 主对话发言：送协调者 inbox，UI 立刻显示已接收，不等模型回复。 */
  async sendUserMessage(projectId: string, text: string): Promise<BoxEnvelope> {
    const project = await this.mount(projectId)
    return await project.box.send({
      sender: USER_ADDRESS,
      recipients: [agentAddress(project.record.coordinatorId)],
      placement: { kind: 'main' },
      kind: 'user-message',
      text,
    })
  }

  /**
   * 直接给某个 Thread 留言。协调者另收一条可追溯的活动通知，而不是把用户的话当成自己的
   * 指令塞进协调者的 inbox。
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
        placement: { kind: 'main' },
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
    await ctx.plugin(blackboardLocal, { root: join(directory, 'blackboard') })
    await ctx.plugin(artifactLocal, { root: join(directory, 'artifacts') })
    await ctx.plugin(boxBlackboard, { projectId: record.id })
    await ctx.plugin(agents)
    await ctx.plugin(threadLocal, {
      projectId: record.id,
      root: directory,
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
      await ctx.plugin(builtinTools, { cwd, ...(config ?? {}) })
      // 搜索与溢出是两条能力缝：组合层挑 Provider，模型可见的工具只认识 ctx.search
      // 与 ctx.spillStore。
      await ctx.plugin(searchRipgrep, { cwd })
      await ctx.plugin(toolSearch, { cwd })
      await ctx.plugin(spillLocal, { cwd })
      await ctx.plugin(toolSpill)
    }

    await ctx.plugin(toolBlackboard)
    await ctx.plugin(toolThread)
    await ctx.plugin(toolBox)

    const registry = ctx.get('agents') as AgentRegistry
    const threads = ctx.get('threads') as ThreadService
    const toolService = ctx.get('tools') as ToolsService
    const permission: PermissionMode = this.options.permission
    const track = (entry: ThreadRecord): void => {
      this.permissions.set(entry.id, entry.permission)
    }
    await threads.ensureRoot(record)
    for (const thread of await threads.list()) track(thread)
    ctx.on('thread/spawned', (event: { thread: ThreadRecord }) => track(event.thread))
    toolService.guard(permissionGuard(permission, record.id, this.options.approvals, {
      workspace: this.workspace,
      // 没有记录的 Agent（例如 Thread 内部再起的普通 Subagent）按最窄处理。
      agentMode: agentId => this.permissions.get(agentId) as ThreadPermission | undefined,
    }))

    await ctx.plugin(projectLoop, { projectId: record.id })

    return {
      record,
      ctx,
      box: ctx.get('box') as BoxService,
      threads,
      blackboard: ctx.get('blackboard') as BlackboardService,
      artifacts: ctx.get('artifacts') as ArtifactStore,
      registry,
      tools: toolService,
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
