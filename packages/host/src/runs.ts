import { IncomingMessage, ServerResponse } from 'node:http'
import { HttpError, errorMessage, readJsonBody, sendError, sendJson, writeSse } from '@tnega/web-kit'
import { MAX_RUN_BODY_BYTES, adapterFromConfig, compactionAdapter, hostPlugins, isActive, mountBrowser, parseRunAttachments, permissionNotice, processesFor, resolveSessionLlm, runKey, searchApiKey, sessionFilePath, sessionModelRoute, userMessage } from './support.js'
import type { ResidentAgentEntry, ServerContext } from './context.js'
import { agents, continuationNudge, findInterruptedTurn, type AgentCreationOptions, type AgentHandle, type AgentRegistry, type AgentStreamEvent, type LiveAgent } from '@tnega/agent'
import { Context, type Fiber, type Plugin } from '@tnega/core'
import { observePtc } from './ptc-observation.js'
import { observeCompaction } from '@tnega/compaction'
import { autoNameSession } from '@tnega/compaction'
import { autoContextBudget } from '@tnega/compaction'
import type { PtcRuntimeQuickjsConfig } from '@tnega/ptc-runtime-quickjs'
import { userQuestions, formatQuestionAnswer, type PendingQuestionRequest, type QuestionAnswers } from '@tnega/user-questions'
import { toolQuestion } from '@tnega/tool-question'
import { mountApprovalReview, reviewAutomaticApproval } from '@tnega/approval-host'
import { createCodingAgentPlugin, renderSkillIndex, createSlashRegistry, generatePlan, type CodingService, type Plan, type SlashCommandResult } from '@tnega/coding-agent'
import { openaiCompatAdapter } from '@tnega/llm'
import { routedAdapter, runSettings } from '@tnega/run-settings'
import { changeGoal, createGoal, goalTools, readGoal, writeGoal } from '@tnega/goal'
import { personaFor } from '@tnega/persona'
import { session, SessionLog, type AgentType, type ModelAttachment, type ModelMessage, type PlanPayload, type SessionEvent } from '@tnega/session'
import { PlaywrightBrowserHost } from '@tnega/browser-playwright'
import { subagentLocal } from '@tnega/subagent-local'
import { toolSubagent } from '@tnega/tool-subagent'
import { ProcessRegistry, tools, type ToolsService } from '@tnega/tools'
import type { SecretVault } from '@tnega/secrets-local'
import { ApprovalBroker, permissionGuard, type PermissionMode } from '@tnega/approval-host'
import { runtimeCapabilities } from '@tnega/runtime'
import { workspaceSubagentRoot } from '@tnega/home'
import { captureFileEditBaseline, captureWritePreimage, editedFiles } from '@tnega/workspace-files'
import { toolWebSearch } from '@tnega/tool-web-search'
import { builtinTools, createAgentRuntime, type AgentRuntime } from '@tnega/runtime'
import { readSystemConfig, type EffectiveLlmConfig, type SystemConfig } from '@tnega/config'
import { patchSessionMeta, readSessionSummary } from '@tnega/session-store'

export async function handleRun(
  req: IncomingMessage,
  res: ServerResponse,
  context: ServerContext,
  workspace: string,
  id: string,
): Promise<void> {
  if (isActive(context.activeRuns, workspace, id)) {
    sendError(res, 409, 'session already has an active run')
    return
  }
  const body = await readJsonBody(req, MAX_RUN_BODY_BYTES)
  const resumeQueued = body.resumeQueued === true
  const attachments = parseRunAttachments(body.attachments)
  if (typeof attachments === 'string') {
    sendError(res, 400, attachments)
    return
  }
  if (!resumeQueued && !attachments.length && (typeof body.prompt !== 'string' || !body.prompt.trim())) {
    sendError(res, 400, 'prompt is required')
    return
  }
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  const requestId = submissionId(body.requestId)
  const summary = await readSessionSummary(workspace, id)
  const permission: PermissionMode = summary.permission ?? 'read-only'
  const agentType = summary.agentType ?? 'general'
  const coding = agentType === 'coding'
  const persona = `${personaFor(agentType)}\n\n${await renderSkillIndex(workspace)}`
  const mode = summary.mode ?? 'auto'

  const config = await readSystemConfig(context.configFile)
  const { effective, apiKey } = resolveSessionLlm(config, summary.model, summary.reasoningEffort)
  if (!effective.apiKeySet) {
    sendError(res, 400, 'API key is not configured')
    return
  }
  if (!apiKey) {
    sendError(res, 400, 'API key is not configured')
    return
  }

  if (resumeQueued || context.resident && (mode === 'auto' || mode === 'goal')) {
    await runResidentTurn(context, res, workspace, id, {
      prompt,
      permission,
      sessionId: id,
      approvals: context.approvals,
      agentType,
      goalMode: mode === 'goal',
      effective,
      apiKey,
      route: sessionModelRoute(context.configFile, workspace, id),
      config,
      resumeQueued,
      attachments,
      ...(requestId ? { requestId } : {}),
      ...(context.ptcRuntime ? { ptcRuntime: context.ptcRuntime } : {}),
      ...(context.browser ? { browser: context.browser } : {}),
      processes: processesFor(context, workspace),
      ...(context.secrets ? { secrets: context.secrets } : {}),
      hostPlugins: hostPlugins(context, workspace),
    })
    return
  }

  await evictResident(context, workspace, id)

  const controller = new AbortController()
  const adapter = adapterFromConfig(effective, apiKey)
  const route = sessionModelRoute(context.configFile, workspace, id)
  let runtime: AgentRuntime | undefined
  let approvalFiber: { dispose(): Promise<void> } | undefined
  try {
    runtime = await createAgentRuntime({
      cwd: workspace,
      sessionFile: sessionFilePath(workspace, id),
      durableInbox: true,
      ...(context.ptcRuntime ? { ptcRuntime: context.ptcRuntime } : {}),
      ptc: { mode: config.codeMode ? 'ptc' : 'native' },
      // A model or effort chosen mid-run takes effect at the next step.
      llm: routedAdapter(route.adapterFor, adapter),
      ...(effective.contextWindow !== undefined ? { contextWindow: effective.contextWindow } : {}),
      allowNetwork: true,
      allowShell: true,
      sandboxMode: permission,
      office: agentType === 'work' ? true : 'auto',
      ...(context.secrets ? { secrets: { vault: context.secrets, sessionId: id } } : {}),
      builtinTools: {
        cwd: workspace,
        allowNetwork: true,
        allowShell: true,
        ...(config.fsGuard ? { fsGuard: config.fsGuard } : {}),
        allowOutsideWorkspace: permission === 'bypass',
        allowPrivateNetwork: permission === 'bypass',
        processes: processesFor(context, workspace),
      },
      plugins: [
        ...(coding ? [createCodingAgentPlugin({ cwd: workspace, mode, registerAgent: false })] : []),
        ...hostPlugins(context, workspace),
      ],
    })
    const toolService = runtime.root.get('tools')
    await runtime.root.plugin(toolWebSearch, { apiKey: searchApiKey(effective, apiKey) })
    await mountBrowser(runtime.root, context.browser)
    const settingsRoot = runtime.root
    await settingsRoot.plugin(runSettings, {
      // This runtime's own agent has no id; anything else is a subagent.
      session: (agentId: string | undefined) => agentId === undefined ? settingsRoot.get('session') : undefined,
      selection: route.selection,
      permissionNotice: (level: PermissionMode) => permissionNotice(level, workspace),
    })
    approvalFiber = await mountApprovalReview(runtime.root, {
      config, workspace, adapter, model: effective.model,
      session: () => runtime?.root.get('session'),
      mode: async () => (await readSessionSummary(workspace, id)).approvalMode ?? config.approvalReview?.defaultMode ?? 'manual',
    })
    const root = runtime.root
    const questionInbox = runtime.inbox
    if (!questionInbox) throw new Error('Durable question inbox is unavailable')
    await root.plugin(userQuestions, {
      resolveSession: () => root.get('session'),
      deliverNonblocking: (request: PendingQuestionRequest, answers: QuestionAnswers) => deliverQuestionSteer(
        root.get('session'), input => questionInbox.steer(input), request, answers,
      ),
    })
    await root.plugin(toolQuestion, { agentId: id })
    context.questionRoots?.set(runKey(workspace, id), root)
    context.questionInboxes?.set(runKey(workspace, id), questionInbox)
    toolService.guard(permissionGuard(permission, runKey(workspace, id), context.approvals, {
      workspace,
      review: request => reviewAutomaticApproval(root, request),
      browserUrl: () => context.browser?.state().url,
    }))
  } catch (error) {
    await approvalFiber?.dispose()
    await runtime?.dispose()
    sendError(res, 500, `failed to start agent: ${errorMessage(error)}`)
    return
  }

  const key = runKey(workspace, id)
  context.activeRuns.set(key, controller)
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.flushHeaders()
  const detachApproval = context.approvals.attach(key, event => {
    if (!res.destroyed && !res.writableEnded) writeSse(res, event)
  })
  res.once('close', () => {
    detachApproval()
  })

  let ptcObservation: Fiber | undefined
  let compactionObservation: Fiber | undefined
  let editTracking: { session: SessionLog; startSeq: number; baseline: Awaited<ReturnType<typeof captureFileEditBaseline>> } | undefined

  try {
    ptcObservation = await observePtc(runtime.root, id, event => {
      if (!res.destroyed && !res.writableEnded) writeSse(res, event)
    })
    const sessionLog = runtime.root.get('session')
    compactionObservation = await observeCompaction(runtime.root, sessionLog, event => {
      if (!res.destroyed && !res.writableEnded) writeSse(res, event)
    })
    editTracking = {
      session: sessionLog,
      startSeq: (await sessionLog.read()).at(-1)?.seq ?? 0,
      baseline: await captureFileEditBaseline(workspace),
    }
    const editBaseline = editTracking.baseline
    const toolService = runtime.root.get('tools')
    toolService.guard(async request => {
      if (request.name === 'write_file' || request.name === 'edit_file') {
        await captureWritePreimage(workspace, editBaseline, request.input)
      }
      return undefined
    })
    const history = await sessionLog.deriveMessages()
    const emitSse = (event: Record<string, unknown>): void => {
      if (!res.destroyed && !res.writableEnded) writeSse(res, event)
    }
    let plan: Plan | undefined
    if (mode === 'plan') {
      plan = await ensurePlanForRun({
        adapter,
        session: sessionLog,
        messages: [...history, userMessage(prompt, attachments)],
        signal: controller.signal,
        emit: emitSse,
      })
      await sessionLog.append('user/message', {
        content: prompt,
        ...(attachments.length ? { attachments } : {}),
      })
      await sessionLog.append('assistant/message', {
        content: [plan.summary ?? 'Plan', ...plan.items.map((item, index) => `${index + 1}. ${item.title}`)].join('\n'),
      })
      await sessionLog.flush()
      await autoNameSession(sessionLog, adapter)
      await runtime.dispose()
      runtime = undefined
      if (!res.destroyed && !res.writableEnded) writeSse(res, { type: 'done' })
      return
    }
    // A coding or work session's first run persists its persona as a durable
    // system/message, so a resumed run's derived history already leads with it;
    // prepending it again would duplicate the persona in the model input
    // (and in the top-level system once Anthropic folds the messages).
    const messages: ModelMessage[] = [
      ...(persona && history[0]?.role !== 'system'
        ? [{ role: 'system' as const, content: persona }]
        : []),
      ...history,
      userMessage(prompt, attachments),
    ]
    const agent = runtime.root.get('agent') as {
      runStream(
        input: { text: string; messages: typeof messages },
        options: { signal: AbortSignal },
      ): AsyncGenerator<AgentStreamEvent, unknown, void>
    }
    const iterator = agent.runStream(
      { text: prompt, messages },
      { signal: controller.signal },
    )
    while (true) {
      const next = await iterator.next()
      if (next.done) break
      try {
        if (!res.destroyed && !res.writableEnded) writeSse(res, next.value)
      } catch {
        // The client may have disconnected; the run itself must continue.
      }
    }
    // The model Run has closed; title generation is not a steering boundary.
    context.questionInboxes?.delete(key)
    await autoNameSession(sessionLog, adapter)
    if (!res.destroyed && !res.writableEnded) writeSse(res, { type: 'done' })
  } catch (error) {
    if (!res.destroyed && !res.writableEnded) {
      writeSse(res, { type: 'error', message: errorMessage(error) })
    }
  } finally {
    await ptcObservation?.dispose()
    await compactionObservation?.dispose()
    if (runtime && editTracking) {
      try {
        const edited = await editedFiles(workspace, editTracking.baseline,
          await editTracking.session.read(), editTracking.startSeq)
        if (edited.length) await editTracking.session.append('meta', { kind: 'files/edited', files: edited })
        await editTracking.session.flush()
      } catch {
        // A file summary must not prevent the run from closing.
      }
    }
    detachApproval()
    context.activeRuns.delete(key)
    context.questionRoots?.delete(key)
    context.questionInboxes?.delete(key)
    await approvalFiber?.dispose()
    if (runtime) await runtime.dispose()
    if (!res.destroyed && !res.writableEnded) res.end()
  }
}

export interface ResidentRunRequest {
  ptcRuntime?: PtcRuntimeQuickjsConfig
  resumeQueued?: boolean
  /** The client's id for this submission; a retry with the same id is admitted once. */
  requestId?: string
  attachments?: ModelAttachment[]
  browser?: PlaywrightBrowserHost
  processes?: ProcessRegistry
  /** The host's secret vault; the runtime binds it to this Session. */
  secrets?: SecretVault
  /** Host-level plugins: the hot profile carrier and the plugin dev workshop. */
  hostPlugins?: readonly Plugin[]
  config: SystemConfig
  prompt: string
  permission: PermissionMode
  sessionId: string
  approvals: ApprovalBroker
  agentType: AgentType
  goalMode: boolean
  effective: EffectiveLlmConfig
  apiKey: string
  /** The Session's live model selection, read at every step. */
  route: ReturnType<typeof sessionModelRoute>
}

export async function evictResident(context: ServerContext, workspace: string, id: string): Promise<void> {
  const key = runKey(workspace, id)
  const entry = context.residentAgents?.get(key)
  if (!entry) return
  context.residentAgents?.delete(key)
  await entry.dispose()
}

export async function createResidentRuntime(
  workspace: string,
  req: ResidentRunRequest,
): Promise<{ root: Context; dispose: () => Promise<void> }> {
  const root = new Context()
  const currentPermission = async (): Promise<PermissionMode> => {
    return (await readSessionSummary(workspace, req.sessionId)).permission ?? 'read-only'
  }
  const sessionOf = (agentId?: string) => root.get('agents', false)?.get(agentId ?? req.sessionId)?.session

  await root.plugin(runtimeCapabilities, {
    workspace,
    permission: currentPermission,
    sessionId: req.sessionId,
    builtin: {
      allowNetwork: true,
      allowShell: true,
      ...(req.config.fsGuard ? { fsGuard: req.config.fsGuard } : {}),
      allowOutsideWorkspace: async () => (await currentPermission()) === 'bypass',
      allowPrivateNetwork: async () => (await currentPermission()) === 'bypass',
      ...(req.processes ? { processes: req.processes } : {}),
    },
    memory: true,
    summary: true,
    // Documents are what a work session delivers, so its office tools are not
    // conditional on finding one first.
    office: req.agentType === 'work' ? true : 'auto',
    ...(req.secrets ? { secrets: { vault: req.secrets, sessionId: req.sessionId } } : {}),
    // Long turns are fine while they keep moving; a turn that stalls is nudged, then parked.
    loopGuard: true,
    jobs: { resolveSession: sessionOf },
    ptc: {
      mode: req.config.codeMode ? 'ptc' : 'native',
      ...(req.ptcRuntime ? { runtime: req.ptcRuntime } : {}),
      resolveSession: sessionOf,
    },
  })
  if (req.agentType === 'coding') {
    await root.plugin(createCodingAgentPlugin({
      cwd: workspace,
      mode: 'auto',
      registerAgent: false,
    }))
  }
  await root.plugin(agents)
  const registry = root.get('agents')
  // A turn that stops on "Let me run the tests:" is steered back to work.
  await root.plugin(continuationNudge)
  const toolService = root.get('tools')
  await root.plugin(userQuestions, {
    resolveSession: (agentId: string) => agentId === req.sessionId ? registry?.get(agentId)?.session : undefined,
    deliverNonblocking: async (request: PendingQuestionRequest, answers: QuestionAnswers) => {
      const agent = registry?.get(request.agentId)
      if (!agent) throw new Error('Question Agent is unavailable')
      await deliverQuestionSteer(agent.session, input => agent.steer(input), request, answers)
    },
  })
  await root.plugin(toolQuestion)
  await mountApprovalReview(root, {
    config: req.config, workspace,
    adapter: adapterFromConfig(req.effective, req.apiKey), model: req.effective.model,
    session: agentId => registry?.get(agentId ?? req.sessionId)?.session,
    mode: async () => (await readSessionSummary(workspace, req.sessionId)).approvalMode ?? req.config.approvalReview?.defaultMode ?? 'manual',
  })
  await root.plugin(toolWebSearch, { apiKey: searchApiKey(req.effective, req.apiKey) })
  await mountBrowser(root, req.browser)
  // Model, effort and permission changed mid-turn apply at the next step.
  await root.plugin(runSettings, {
    session: (agentId: string | undefined) => agentId === req.sessionId ? registry?.get(agentId)?.session : undefined,
    selection: req.route.selection,
    permissionNotice: (level: PermissionMode) => permissionNotice(level, workspace),
  })
  toolService.guard(permissionGuard(currentPermission, runKey(workspace, req.sessionId), req.approvals, {
    workspace,
    review: request => reviewAutomaticApproval(root, request),
    browserUrl: () => req.browser?.state().url,
    agentMode: agentId => {
      const meta = registry?.get(agentId)?.meta
      if (!meta?.subagentMode) return undefined
      return meta.subagentPermission ?? (meta.subagentAllowShell ? 'workspace-write' : 'read-only')
    },
  }))
  await root.plugin(goalTools)
  await root.plugin(subagentLocal, {
    cwd: workspace,
    storageRoot: workspaceSubagentRoot(workspace),
    llm: adapterFromConfig(req.effective, req.apiKey),
    ...(req.effective.contextWindow !== undefined ? { contextWindow: req.effective.contextWindow } : {}),
    allowShell: req.permission !== 'read-only',
    allowNetwork: true,
    permission: req.permission,
  })
  await root.plugin(toolSubagent)
  for (const plugin of req.hostPlugins ?? []) await root.plugin(plugin)
  return {
    root,
    dispose: async () => {
      await root.fiber.dispose()
    },
  }
}

export async function ensureResidentAgent(
  context: ServerContext,
  workspace: string,
  id: string,
  req: ResidentRunRequest,
): Promise<ResidentAgentEntry> {
  const key = runKey(workspace, id)
  const pending = context.residentCreation?.get(key)
  if (pending) return pending
  const creation = createResidentAgent(context, workspace, id, req)
  context.residentCreation?.set(key, creation)
  try { return await creation }
  finally { if (context.residentCreation?.get(key) === creation) context.residentCreation.delete(key) }
}

/**
 * Identity of a resident runtime: anything in here that changes has to rebuild
 * the runtime instead of reusing it.
 *
 * `permission` is part of it because `subagentLocal` snapshots the level (as
 * `permission` and `allowShell`) when the runtime is built: reusing a runtime
 * across a permission change would keep spawning subagents with the old level,
 * while the main session's own guard follows the live value.
 */
export function residentSignature(req: ResidentRunRequest): string {
  return [
    req.effective.baseUrl,
    req.effective.model,
    req.apiKey,
    req.effective.reasoningEffort ?? '',
    req.effective.contextWindow ?? '',
    req.effective.protocol ?? '',
    req.effective.temperature ?? '',
    JSON.stringify(req.config.approvalReview ?? {}),
    req.config.codeMode ? 'ptc' : 'native',
    // The file tools read their guard mode when they are built.
    req.config.fsGuard ?? 'warn',
    req.agentType,
    req.permission,
    'auto',
  ].join('|')
}

export async function createResidentAgent(
  context: ServerContext,
  workspace: string,
  id: string,
  req: ResidentRunRequest,
): Promise<ResidentAgentEntry> {
  const key = runKey(workspace, id)
  const signature = residentSignature(req)
  const existing = context.residentAgents?.get(key)
  if (existing && existing.signature === signature) return existing
  if (existing) {
    await existing.dispose()
    context.residentAgents?.delete(key)
  }

  const runtime = await createResidentRuntime(workspace, req)
  let agent: LiveAgent
  let disposeAgent: () => Promise<void>
  try {
    const registry = (runtime.root as unknown as { agents: AgentRegistry }).agents
    const options: AgentCreationOptions = {
      file: sessionFilePath(workspace, id),
      sessionId: id,
      id,
      mode: 'auto',
      llm: routedAdapter(req.route.adapterFor, adapterFromConfig(req.effective, req.apiKey)),
      ...(req.effective.contextWindow !== undefined ? { contextWindow: req.effective.contextWindow } : {}),
      // Long sessions compact themselves (see auto-compaction.ts).
      contextBudget: autoContextBudget({
        llm: () => compactionAdapter(req.effective, req.apiKey),
        ...(req.effective.contextWindow !== undefined ? { contextWindow: req.effective.contextWindow } : {}),
      }),
      manualStreaming: true,
    }
    // General sessions stay untyped, as they always have been.
    if (req.agentType !== 'general') options.agentType = req.agentType
    let handle: AgentHandle
    try {
      handle = await registry.resume(options)
    } catch (error) {
      if (!isAgentMetaMissing(error)) throw error
      handle = await registry.create(options)
    }
    agent = handle.agent
    disposeAgent = handle.dispose
  } catch (error) {
    await runtime.dispose()
    throw error
  }

  const entry: ResidentAgentEntry = {
    root: runtime.root,
    agent,
    registry: (runtime.root as unknown as { agents: AgentRegistry }).agents,
    tools: runtime.root.get('tools'),
    signature,
    dispose: async () => {
      await disposeAgent().catch(() => undefined)
      await runtime.dispose()
    },
  }
  context.residentAgents?.set(key, entry)
  return entry
}

export function isAgentMetaMissing(error: unknown): boolean {
  return error instanceof Error && error.message.includes('no agent session meta found')
}

export async function deliverQuestionSteer(
  session: SessionLog,
  steer: (input: { text: string }) => Promise<unknown>,
  request: PendingQuestionRequest,
  answers: QuestionAnswers,
): Promise<void> {
  const text = formatQuestionAnswer(request, answers)
  const delivered = (await session.read()).some(event => event.type === 'agent/inbox/spliced'
    && event.payload.target !== 'all' && event.payload.inserted?.some(message => message.content === text))
  if (!delivered) await steer({ text })
  await session.flush()
}

export function submissionId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value) ? value : undefined
}

export function recoveryField(events: readonly SessionEvent[]): { recovery?: { safe: boolean; uncertainCalls: string[] } } {
  const interrupted = findInterruptedTurn(events)
  return interrupted ? { recovery: { safe: interrupted.safe, uncertainCalls: interrupted.uncertainCalls } } : {}
}

export async function residentQuestionRequest(context: ServerContext, workspace: string, id: string): Promise<ResidentRunRequest> {
  const summary = await readSessionSummary(workspace, id)
  const config = await readSystemConfig(context.configFile)
  const { effective, apiKey } = resolveSessionLlm(config, summary.model, summary.reasoningEffort)
  if (!apiKey) throw new HttpError(400, 'API key is not configured')
  return {
    prompt: '', permission: summary.permission ?? 'read-only', sessionId: id,
    approvals: context.approvals, agentType: summary.agentType ?? 'general', goalMode: false,
    effective, apiKey, config, resumeQueued: true,
    route: sessionModelRoute(context.configFile, workspace, id),
    processes: processesFor(context, workspace),
    ...(context.secrets ? { secrets: context.secrets } : {}),
    ...(context.ptcRuntime ? { ptcRuntime: context.ptcRuntime } : {}),
  }
}

export async function runResidentTurn(
  context: ServerContext,
  res: ServerResponse,
  workspace: string,
  id: string,
  req: ResidentRunRequest,
): Promise<void> {
  const key = runKey(workspace, id)
  let markReady: (ready: boolean) => void = () => undefined
  const ready = new Promise<boolean>(resolveReady => { markReady = resolveReady })
  context.steeringReady.set(key, ready)
  const controller = new AbortController()
  context.activeRuns.set(key, controller)
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.flushHeaders()
  const detachApproval = context.approvals.attach(key, event => {
    if (!res.destroyed && !res.writableEnded) writeSse(res, event)
  })
  res.once('close', () => {
    detachApproval()
  })

  let ptcObservation: Fiber | undefined
  let compactionObservation: Fiber | undefined
  let editTracking: { session: SessionLog; startSeq: number; baseline: Awaited<ReturnType<typeof captureFileEditBaseline>> } | undefined
  let releaseWriteCapture: ReturnType<ToolsService['guard']> | undefined

  try {
    const entry = await ensureResidentAgent(context, workspace, id, req)
    ptcObservation = await observePtc(entry.root, id, event => {
      if (!res.destroyed && !res.writableEnded) writeSse(res, event)
    })
    const agent = entry.agent
    compactionObservation = await observeCompaction(entry.root, agent.session, event => {
      if (!res.destroyed && !res.writableEnded) writeSse(res, event)
    })
    editTracking = {
      session: agent.session,
      startSeq: (await agent.session.read()).at(-1)?.seq ?? 0,
      baseline: await captureFileEditBaseline(workspace),
    }
    const editBaseline = editTracking.baseline
    releaseWriteCapture = entry.tools.guard(async request => {
      if (request.name === 'write_file' || request.name === 'edit_file') {
        await captureWritePreimage(workspace, editBaseline, request.input)
      }
      return undefined
    })
    // A coding or work session keeps its persona as the durable leading system
    // message, seeded once so every derived request begins with it.
    const persona = `${personaFor(req.agentType)}\n\n${await renderSkillIndex(workspace)}`
    if (persona) {
      const history = await agent.session.deriveMessages()
      if (!history.some(message => message.role === 'system')) {
        await agent.session.append('system/message', { content: persona })
      }
    }
    let goal = req.goalMode ? await readGoal(agent.session) : undefined
    if (req.goalMode && !goal) goal = await createGoal(agent.session, req.prompt)
    if (!req.resumeQueued) {
      await agent.followup({
        text: req.prompt,
        ...(req.attachments?.length ? { attachments: req.attachments } : {}),
        ...(req.requestId ? { requestId: req.requestId } : {}),
      })
    }
    while (true) {
      for await (const event of agent.runTurns(controller.signal)) {
        markReady(true)
        if (!res.destroyed && !res.writableEnded) writeSse(res, event)
      }
      if (!req.goalMode) break
      goal = await readGoal(agent.session)
      if (!goal || goal.status !== 'active') break
      if (controller.signal.aborted) {
        await changeGoal(agent.session, 'paused', 'Run cancelled by the user')
        break
      }
      const lastTurn = [...await agent.session.read()].reverse()
        .find(event => event.type === 'turn/end')
      if (lastTurn?.type === 'turn/end' && lastTurn.payload.finishReason !== 'stop') {
        await changeGoal(agent.session, 'blocked', `Agent turn ended: ${lastTurn.payload.finishReason ?? 'unknown'}`)
        break
      }
      const rounds = goal.rounds + 1
      if (rounds >= goal.maxRounds) {
        await writeGoal(agent.session, { ...goal, rounds, status: 'blocked', detail: 'Automatic round limit reached' })
        break
      }
      await writeGoal(agent.session, { ...goal, rounds })
      await agent.followup({ text: `<goal_round>\nObjective: ${JSON.stringify(goal.objective)}\nRound ${rounds + 1}/${goal.maxRounds}. Continue toward the objective using the current Session and Workspace. Call update_goal when complete, paused, or blocked.\n</goal_round>` })
    }
    await agent.session.flush()
    if (req.prompt) await autoNameSession(agent.session, adapterFromConfig(req.effective, req.apiKey))
    if (!res.destroyed && !res.writableEnded) writeSse(res, { type: 'done' })
  } catch (error) {
    if (!res.destroyed && !res.writableEnded) {
      writeSse(res, { type: 'error', message: errorMessage(error) })
    }
  } finally {
    await ptcObservation?.dispose()
    await compactionObservation?.dispose()
    await releaseWriteCapture?.()
    if (editTracking) {
      try {
        const edited = await editedFiles(workspace, editTracking.baseline,
          await editTracking.session.read(), editTracking.startSeq)
        if (edited.length) await editTracking.session.append('meta', { kind: 'files/edited', files: edited })
        await editTracking.session.flush()
      } catch {
        // A file summary must not prevent the run from closing.
      }
    }
    detachApproval()
    context.activeRuns.delete(key)
    markReady(false)
    context.steeringReady.delete(key)
    if (!res.destroyed && !res.writableEnded) res.end()
  }
}

export interface EnsurePlanForRunOptions {
  adapter: ReturnType<typeof openaiCompatAdapter>
  session: SessionLog
  messages: readonly ModelMessage[]
  signal?: AbortSignal
  emit: (event: Record<string, unknown>) => void
}

export async function ensurePlanForRun(options: EnsurePlanForRunOptions): Promise<Plan> {
  options.emit({ type: 'plan/start' })
  try {
    const plan = await generatePlan(options.adapter, options.messages, options.signal)
    await options.session.append('plan', planPayload(plan))
    options.emit({ type: 'plan/items', plan })
    for (const item of plan.items) {
      options.emit({ type: 'plan/item', item })
    }
    options.emit({ type: 'plan/done', plan })
    return plan
  } catch (error) {
    options.emit({ type: 'plan/error', message: errorMessage(error) })
    throw error
  }
}

export function planPayload(plan: Plan): PlanPayload {
  return {
    items: plan.items.map(item => ({
      id: item.id,
      title: item.title,
      status: item.status,
      ...(item.detail ? { detail: item.detail } : {}),
    })),
    status: plan.status,
    ...(plan.summary ? { summary: plan.summary } : {}),
  }
}

export async function handleCodingCommands(
  res: ServerResponse,
  workspace: string,
  id: string,
): Promise<void> {
  const summary = await readSessionSummary(workspace, id)
  sendJson(res, 200, {
    commands: createSlashRegistry().list(),
    agentType: summary.agentType ?? 'general',
    mode: summary.mode ?? 'auto',
  })
}

export async function handleCodingSlash(
  req: IncomingMessage,
  res: ServerResponse,
  workspace: string,
  id: string,
): Promise<void> {
  const summary = await readSessionSummary(workspace, id)
  if (summary.agentType !== 'coding') {
    sendError(res, 400, 'session is not a coding session')
    return
  }
  const body = await readJsonBody(req)
  const name = typeof body.name === 'string' && body.name.trim()
    ? body.name.trim()
    : ''
  if (!name) {
    sendError(res, 400, 'name is required')
    return
  }
  const args = Array.isArray(body.args)
    ? body.args.filter((arg): arg is string => typeof arg === 'string')
    : []
  if (name === '/skills' && (args[0] === 'create' || args[0] === 'install')
    && (summary.permission ?? 'read-only') === 'read-only') {
    sendError(res, 403, 'Skill creation and installation require workspace-write permission.')
    return
  }
  if (name === '/plan') {
    await patchSessionMeta(workspace, id, { mode: 'plan' })
    const result: SlashCommandResult = { kind: 'text', text: 'Plan mode selected. Send a request to generate a plan.' }
    await appendSlashMeta(workspace, id, name, args, result)
    sendJson(res, 200, { result, mode: 'plan' })
    return
  }

  if (name === '/goal') {
    const result = await withCodingAgent(workspace, id, async (_coding, log): Promise<SlashCommandResult> => {
      const action = args[0]?.toLowerCase()
      if (!action) {
        return { kind: 'json', value: await readGoal(log) ?? { status: 'none' } }
      }
      if (args.length === 1 && action === 'clear') {
        await log.append('meta', { kind: 'goal/clear' })
        await log.append('meta/patch', { fields: ['mode'], mode: 'auto' })
        await log.flush()
        return { kind: 'text', text: 'Goal cleared.' }
      }
      if (args.length === 1 && (action === 'pause' || action === 'resume')) {
        const goal = await changeGoal(log, action === 'pause' ? 'paused' : 'active')
        if (action === 'resume') {
          await log.append('meta/patch', { fields: ['mode'], mode: 'goal' })
          await log.flush()
        }
        return { kind: 'json', value: goal }
      }
      const goal = await createGoal(log, args.join(' '))
      await log.append('meta/patch', { fields: ['mode'], mode: 'goal' })
      await log.flush()
      return { kind: 'json', value: goal }
    })
    await appendSlashMeta(workspace, id, name, args, result)
    sendJson(res, 200, { result, mode: (await readSessionSummary(workspace, id)).mode ?? 'auto' })
    return
  }
  const result = await withCodingAgent(workspace, id, async (coding, sessionLog) => {
    const result: SlashCommandResult = await coding.runCommand(name, args)
    await sessionLog.append('meta', {
      kind: 'slash',
      command: name,
      args,
      result,
    })
    return result
  })
  sendJson(res, 200, { result, mode: (await readSessionSummary(workspace, id)).mode ?? 'auto' })
}

export async function handleCodingSlashCandidates(
  req: IncomingMessage,
  res: ServerResponse,
  workspace: string,
  id: string,
): Promise<void> {
  const summary = await readSessionSummary(workspace, id)
  if (summary.agentType !== 'coding') {
    sendError(res, 400, 'session is not a coding session')
    return
  }
  const body = await readJsonBody(req)
  const name = typeof body.name === 'string' && body.name.trim()
    ? body.name.trim()
    : ''
  if (!name) {
    sendError(res, 400, 'name is required')
    return
  }
  const candidates = await withCodingAgent(workspace, id, coding => coding.suggestCommand(name))
  sendJson(res, 200, { candidates })
}

export async function withCodingAgent<T>(
  workspace: string,
  id: string,
  run: (coding: CodingService, sessionLog: SessionLog) => Promise<T>,
): Promise<T> {
  const summary = await readSessionSummary(workspace, id)
  const root = new Context()
  let fiber: { dispose: () => Promise<void> } | undefined
  try {
    await root.plugin(session, { file: sessionFilePath(workspace, id) })
    await root.plugin(tools)
    const registry = root.get('tools')
    registry.guard(permissionGuard(summary.permission ?? 'read-only', runKey(workspace, id), new ApprovalBroker(), { workspace }))
    // A typed slash install URL is an explicit user request to read that source.
    // Model calls only have http_get when their runtime enables network tools.
    await root.plugin(builtinTools, {
      cwd: workspace,
      allowNetwork: true,
      disabled: ['read_file', 'write_file', 'edit_file', 'list_dir'],
    })
    fiber = await root.plugin(createCodingAgentPlugin({
      cwd: workspace,
      skills: true,
      mcp: true,
      planTools: true,
      ...(summary.mode ? { mode: summary.mode } : {}),
      setMode: async (next) => {
        const activeLog = root.get('session')
        await activeLog.append('meta/patch', { fields: ['mode'], mode: next })
        await activeLog.flush()
      },
    }))
    const coding = root.get('coding')
    const sessionLog = root.get('session')
    return await run(coding, sessionLog)
  } finally {
    await fiber?.dispose()
    await root.fiber.dispose()
  }
}

export async function handleStopRun(
  context: ServerContext,
  workspace: string,
  id: string,
): Promise<void> {
  const controller = context.activeRuns.get(runKey(workspace, id))
  if (!controller) throw new HttpError(409, 'session is not running')
  controller.abort({ type: 'user' })
}

export async function appendSlashMeta(
  workspace: string, id: string, name: string, args: string[], result: SlashCommandResult,
): Promise<void> {
  const log = new SessionLog(sessionFilePath(workspace, id))
  await log.init()
  try {
    await log.append('meta', { kind: 'slash', command: name, args, result })
    await log.flush()
  } finally {
    await log.close()
  }
}
