import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { IncomingMessage, ServerResponse } from 'node:http'
import { dedupe, errorMessage, readJsonBody, sendError, sendJson, HttpError } from '@tnega/web-kit'
import { KEEP_RECENT_TOKENS, MAX_RUN_BODY_BYTES, adapterFromConfig, appendPermissionNotice, canonicalWorkspace, compactionAdapter, isActive, optionalCount, optionalSeq, parseRunAttachments, processesFor, runKey, sessionFilePath, userMessage, workspaceParam } from './support.js'
import { Context } from '@tnega/core'
import { configureNetwork } from '@tnega/execution'
import { modelCapabilities } from '@tnega/llm'
import { memoryLocal } from '@tnega/memory-local'
import { buildCompactionPrompt, SUMMARY_PREFIX, SUMMARIZATION_SYSTEM_PROMPT } from '@tnega/compaction'
import { compactSession, prepareSessionCompact, readSessionMessages, type SessionSummary } from '@tnega/session-store'
import { consolidateProjectMemory } from '@tnega/tool-memory'
import { resolve } from 'node:path'
import { recoverInterruptedTurn } from '@tnega/agent'
import { sessionUsage } from '@tnega/usage'
import { discoverModels, ModelDiscoveryError, parseModelDiscoveryInput } from '@tnega/config'
import { pendingQuestionsFromEvents, UserQuestionError } from '@tnega/user-questions'
import { readGoal } from '@tnega/goal'
import { isAgentType, SessionLog } from '@tnega/session'
import { availableShells, configureSystemShell, DEFAULT_ALLOWED_HOSTS, systemShell } from '@tnega/execution'
import { listStoredSubagents, readSubagentEvents } from '@tnega/subagent-local'
import { SubagentError } from '@tnega/subagent'
import { JobRegistry } from '@tnega/jobs'
import { ProjectHost } from '@tnega/project-host'
import { workspaceSubagentRoot } from '@tnega/home'
import { defaultWorkspace } from '@tnega/home'
import { resolveLlmEnv } from '@tnega/config'
import { effectiveApiKey, effectiveLlmConfig, availableModels, readSystemConfig, systemConfigPath, systemConfigProblem, updateSystemConfig, normalizeApprovalReviewer, normalizeProjectMemory, PROJECT_MEMORY_DEFAULTS, normalizeMemoryDream, MEMORY_DREAM_DEFAULTS, ModelRouteError, parseModelRouteInput, parseNetworkConfig, removeModelRoute, upsertModelRoute, type SystemConfig, type SystemConfigPatch } from '@tnega/config'
import { createSession, deleteSession, ensureWorkspace, forkSession, isSessionId, listSessions, searchSessions, patchSessionMeta, readSessionSnapshot, readSessionSummary, setSessionPermission, setSessionApprovalMode, truncateSessionAt } from '@tnega/session-store'
import type { ServerContext } from './context.js'
import { evictResident, ensureResidentAgent, submissionId, recoveryField, residentQuestionRequest, handleRun, handleCodingCommands, handleCodingSlash, handleCodingSlashCandidates, handleStopRun } from './runs.js'
import type { WebServerService } from '@tnega/web-kit'

export const CHATGPT_DEFAULT_MODEL = 'gpt-5-codex'

/**
 * Routes registered at the transport table level. The rest of `/api` still
 * arrives through one `prefix '/api/'` entry and is dispatched by the ordered
 * `apiRoutes` table below; these four are exact named routes so their paths
 * never depend on that ordering. Migrating a domain means moving its entries
 * here (or into the owning package) and deleting them from `apiRoutes`.
 */
export function registerApiRoutes(web: WebServerService): void {
  web.register({
    kind: 'exact',
    method: 'GET',
    path: '/api/health',
    handler: (_req, res) => {
      sendJson(res, 200, { ok: true })
    },
  })
}

/**
 * Transport policy for the whole `/api` surface, applied once at the dispatch
 * boundary instead of inside every route (dsh registers the same idea as a
 * trusted-host interceptor on its shared `/api` handler).
 */
export function rejectsApiRequest(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.headers['x-tnega-client'] !== '1') {
    sendError(res, 403, 'missing x-tnega-client header')
    return true
  }
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    const contentType = req.headers['content-type'] ?? ''
    if (!contentType.toLowerCase().startsWith('application/json')) {
      sendError(res, 415, 'content-type must be application/json')
      return true
    }
  }
  return false
}

interface ApiRoute {
  match: (req: IncomingMessage, url: URL) => boolean
  handle: (req: IncomingMessage, res: ServerResponse, url: URL, context: ServerContext) => Promise<void>
}

const apiRoutes: ApiRoute[] = [
{
    match: (req, url) => {
      const approvalMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/approvals\/([^/]+)$/)
      return Boolean(approvalMatch && req.method === 'POST')
    },
    handle: async (req, res, url, context) => {
      const approvalMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/approvals\/([^/]+)$/)
      if (!(approvalMatch && req.method === 'POST')) return
      const workspace = workspaceParam(url)
      if (!workspace || !isSessionId(approvalMatch[1]!)) {
            sendError(res, 400, 'valid workspace and session id are required')
            return
          }
      const body = await readJsonBody(req)
      if (typeof body.allow !== 'boolean') {
            sendError(res, 400, 'allow must be a boolean')
            return
          }
      const accepted = context.approvals.decide(approvalMatch[2]!, runKey(workspace, approvalMatch[1]!), body.allow)
      if (!accepted) {
            sendError(res, 404, 'approval request is no longer pending')
            return
          }
      sendJson(res, 200, { accepted: true })
      return
    },
  },
{
    match: (req, url) => Boolean(url.pathname === '/api/config' && req.method === 'GET'),
    handle: async (req, res, url, context) => {
      if (!(url.pathname === '/api/config' && req.method === 'GET')) return
      const config = await readSystemConfig(context.configFile)
      const problem = await systemConfigProblem(context.configFile)
      sendJson(res, 200, { ...configSnapshot(config, context.configFile), ...(problem ? { problem } : {}) })
      return
    },
  },
{
    match: (req, url) => Boolean(url.pathname === '/api/config' && req.method === 'PUT'),
    handle: async (req, res, url, context) => {
      if (!(url.pathname === '/api/config' && req.method === 'PUT')) return
      const body = await readJsonBody(req)
      const patch: SystemConfigPatch = {}
      if (body.codeMode !== undefined) {
            if (typeof body.codeMode !== 'boolean') { sendError(res, 400, 'codeMode must be a boolean'); return }
            patch.codeMode = body.codeMode
          }
      if (body.fsGuard !== undefined) {
            if (body.fsGuard !== 'off' && body.fsGuard !== 'warn' && body.fsGuard !== 'enforce') {
              sendError(res, 400, 'fsGuard must be off, warn or enforce'); return
            }
            patch.fsGuard = body.fsGuard
          }
      if (body.projectMemory !== undefined) {
            const memory = normalizeProjectMemory(body.projectMemory)
            if (!memory) { sendError(res, 400, 'Invalid project memory limits'); return }
            const current = await readSystemConfig(context.configFile)
            if (memory.coldModelId && !current.models?.some(route => route.id === memory.coldModelId)) {
              sendError(res, 400, 'Project memory model must be a configured route'); return
            }
            patch.projectMemory = { ...current.projectMemory, ...memory }
          }
      if (body.memoryDream !== undefined) {
            const dream = normalizeMemoryDream(body.memoryDream)
            if (!dream) { sendError(res, 400, 'Invalid dreaming settings'); return }
            const current = await readSystemConfig(context.configFile)
            if (dream.modelId && !current.models?.some(route => route.id === dream.modelId)) {
              sendError(res, 400, 'Dreaming model must be a configured route'); return
            }
            patch.memoryDream = { ...current.memoryDream, ...dream }
          }
      if (typeof body.apiKey === 'string') patch.apiKey = body.apiKey
      if (typeof body.shell === 'string') patch.shell = body.shell.trim()
      if (typeof body.baseUrl === 'string') patch.baseUrl = body.baseUrl
      if (typeof body.model === 'string') patch.model = body.model
      if (body.reasoningEffort === 'low' || body.reasoningEffort === 'medium' || body.reasoningEffort === 'high'
            || body.reasoningEffort === '') patch.reasoningEffort = body.reasoningEffort
      if (body.protocol === 'anthropic' || body.protocol === 'openai' || body.protocol === '') {
            patch.protocol = body.protocol
          }
      if (typeof body.temperature === 'number' && Number.isFinite(body.temperature)) {
            patch.temperature = body.temperature
          }
      if (body.approvalReview !== undefined) {
            const review = normalizeApprovalReviewer(body.approvalReview)
            if (!review) { sendError(res, 400, 'invalid approval reviewer'); return }
            const previous = (await readSystemConfig(context.configFile)).approvalReview
            patch.approvalReview = { ...(previous?.provider === review.provider ? previous : {}), ...review }
          }
      if (body.network !== undefined) {
            const network = parseNetworkConfig(body.network)
            if (!network) { sendError(res, 400, 'network must be an object'); return }
            patch.network = network.allowedHosts || network.proxy ? network : undefined
          }
      const config = await updateSystemConfig(patch, context.configFile)
      configureSystemShell(config.shell)
      applyNetwork(config, context.hostFetch)
      sendJson(res, 200, configSnapshot(config, context.configFile))
      return
    },
  },
{
    match: (req, url) => Boolean(url.pathname === '/api/config/models/discover' && req.method === 'POST'),
    handle: async (req, res, url, context) => {
      if (!(url.pathname === '/api/config/models/discover' && req.method === 'POST')) return
      try {
            const input = parseModelDiscoveryInput(await readJsonBody(req))
            sendJson(res, 200, await discoverModels(input, await readSystemConfig(context.configFile)))
          } catch (error) {
            if (error instanceof ModelRouteError || error instanceof ModelDiscoveryError) {
              sendError(res, error instanceof ModelDiscoveryError ? error.status : 400, error.message)
              return
            }
            throw error
          }
      return
    },
  },
{
    match: (req, url) => {
      const modelRoute = /^\/api\/config\/models\/([^/]+)$/.exec(url.pathname)
      return Boolean(modelRoute && (req.method === 'PUT' || req.method === 'DELETE'))
    },
    handle: async (req, res, url, context) => {
      const modelRoute = /^\/api\/config\/models\/([^/]+)$/.exec(url.pathname)
      if (!(modelRoute && (req.method === 'PUT' || req.method === 'DELETE'))) return
      const id = decodeURIComponent(modelRoute[1]!)
      try {
            const config = req.method === 'PUT'
              ? await upsertModelRoute(id, parseModelRouteInput(await readJsonBody(req)), context.configFile)
              : await removeModelRoute(id, context.configFile)
            sendJson(res, 200, configSnapshot(config, context.configFile))
          } catch (error) {
            if (error instanceof ModelRouteError) {
              sendError(res, 400, error.message)
              return
            }
            throw error
          }
      return
    },
  },
{
    match: (req, url) => Boolean(url.pathname === '/api/processes' && (req.method === 'GET' || req.method === 'POST')),
    handle: async (req, res, url, context) => {
      if (!(url.pathname === '/api/processes' && (req.method === 'GET' || req.method === 'POST'))) return
      const workspace = workspaceParam(url)
      if (!workspace) { sendError(res, 400, 'workspace query parameter is required'); return }
      const registry = context.processes.get(canonicalWorkspace(workspace))
      if (req.method === 'GET' && !url.searchParams.has('process_id')) {
            sendJson(res, 200, { processes: registry?.list() ?? [] })
            return
          }
      const body = req.method === 'POST' ? await readJsonBody(req) : undefined
      if (body && (body.action !== 'stop' || typeof body.process_id !== 'string' || !body.process_id.trim())) {
            sendError(res, 400, 'action=stop and process_id are required'); return
          }
      const id = body?.process_id ?? url.searchParams.get('process_id')
      if (typeof id !== 'string' || !id.trim()) { sendError(res, 400, 'process_id is required'); return }
      const result = body ? await registry?.stop(id) : registry?.read(id)
      if (!result) { sendError(res, 404, 'background process not found'); return }
      sendJson(res, 200, body ? { process: result } : result)
      return
    },
  },
{
    match: (req, url) => Boolean(url.pathname === '/api/workspaces' && req.method === 'GET'),
    handle: async (req, res, url, context) => {
      if (!(url.pathname === '/api/workspaces' && req.method === 'GET')) return
      const config = await readSystemConfig(context.configFile)
      const fallback = defaultWorkspace()
      await mkdir(fallback, { recursive: true })
      sendJson(res, 200, { workspaces: config.workspaces ?? [], defaultWorkspace: await ensureWorkspace(fallback) })
      return
    },
  },
{
    match: (req, url) => Boolean(url.pathname === '/api/workspaces' && req.method === 'POST'),
    handle: async (req, res, url, context) => {
      if (!(url.pathname === '/api/workspaces' && req.method === 'POST')) return
      const body = await readJsonBody(req)
      if (typeof body.path !== 'string' || !body.path.trim()) {
            sendError(res, 400, 'path is required')
            return
          }
      const workspace = await ensureWorkspace(body.path)
      const config = await readSystemConfig(context.configFile)
      const workspaces = dedupe([...(config.workspaces ?? []), workspace])
      await updateSystemConfig({ workspaces }, context.configFile)
      sendJson(res, 200, { path: workspace, workspaces })
      return
    },
  },
{
    match: (req, url) => Boolean(url.pathname === '/api/workspaces' && req.method === 'DELETE'),
    handle: async (req, res, url, context) => {
      if (!(url.pathname === '/api/workspaces' && req.method === 'DELETE')) return
      const body = await readJsonBody(req)
      if (typeof body.path !== 'string') {
            sendError(res, 400, 'path is required')
            return
          }
      const config = await readSystemConfig(context.configFile)
      const path = body.path
      const workspaces = (config.workspaces ?? []).filter(
            entry => entry !== path && entry !== resolve(path),
          )
      await updateSystemConfig({ workspaces }, context.configFile)
      sendJson(res, 200, { workspaces })
      return
    },
  },
{
    match: (req, url) => Boolean(url.pathname === '/api/sessions' && req.method === 'GET'),
    handle: async (req, res, url, context) => {
      if (!(url.pathname === '/api/sessions' && req.method === 'GET')) return
      const workspace = workspaceParam(url)
      if (!workspace) {
            sendError(res, 400, 'workspace query parameter is required')
            return
          }
      // The sidebar's light says what needs you: a run going now, or an approval card waiting on you.
      const sessions = (await listSessions(workspace)).map(session => {
            const running = isActive(context.activeRuns, workspace, session.id)
            const waiting = context.approvals.pendingFor(runKey(workspace, session.id))
            return { ...session, ...(running ? { running } : {}), ...(waiting ? { waiting } : {}) }
          })
      sendJson(res, 200, { workspace, sessions })
      return
    },
  },
{
    match: (req, url) => Boolean(url.pathname === '/api/sessions/search' && req.method === 'GET'),
    handle: async (req, res, url) => {
      if (!(url.pathname === '/api/sessions/search' && req.method === 'GET')) return
      const workspace = workspaceParam(url)
      if (!workspace) {
            sendError(res, 400, 'workspace query parameter is required')
            return
          }
      const query = url.searchParams.get('q') ?? ''
      sendJson(res, 200, { workspace, hits: await searchSessions(workspace, query) })
      return
    },
  },
{
    match: (req, url) => Boolean(url.pathname === '/api/sessions' && req.method === 'POST'),
    handle: async (req, res, url) => {
      if (!(url.pathname === '/api/sessions' && req.method === 'POST')) return
      const workspace = workspaceParam(url)
      if (!workspace) {
            sendError(res, 400, 'workspace query parameter is required')
            return
          }
      const body = await readJsonBody(req)
      const title = typeof body.title === 'string' ? body.title : undefined
      const agentType = isAgentType(body.agentType) ? body.agentType : undefined
      const mode = body.mode === 'auto' || body.mode === 'plan' || body.mode === 'goal'
            ? body.mode
            : undefined
      const session = await createSession(workspace, {
            ...(title !== undefined ? { title } : {}),
            ...(agentType ? { agentType } : {}),
            ...(mode ? { mode } : {}),
          })
      sendJson(res, 201, { session })
      return
    },
  },
{
    match: (req, url) => {
      const codingMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/coding\/(commands|slash|slash-candidates)$/)
      return Boolean(codingMatch)
    },
    handle: async (req, res, url, context) => {
      const codingMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/coding\/(commands|slash|slash-candidates)$/)
      if (!(codingMatch)) return
      const id = codingMatch[1]!
      const action = codingMatch[2]!
      const workspace = workspaceParam(url)
      if (!isSessionId(id)) {
            sendError(res, 400, 'invalid session id')
            return
          }
      if (!workspace) {
            sendError(res, 400, 'workspace query parameter is required')
            return
          }
      if (action === 'commands' && req.method === 'GET') {
            await handleCodingCommands(res, workspace, id)
            return
          }
      if (action === 'slash' && req.method === 'POST') {
            if (isActive(context.activeRuns, workspace, id)) {
              sendError(res, 409, 'session is running')
              return
            }
            await evictResident(context, workspace, id)
            await handleCodingSlash(req, res, workspace, id)
            return
          }
      if (action === 'slash-candidates' && req.method === 'POST') {
            await handleCodingSlashCandidates(req, res, workspace, id)
            return
          }
      sendError(res, 405, 'method not allowed')
      return
    },
  },
{
    match: (req, url) => {
      const subagentMatch = url.pathname.match(/^\/api\/subagents\/([^/]+)$/)
      return Boolean(subagentMatch && req.method === 'GET')
    },
    handle: async (req, res, url) => {
      const subagentMatch = url.pathname.match(/^\/api\/subagents\/([^/]+)$/)
      if (!(subagentMatch && req.method === 'GET')) return
      const workspace = workspaceParam(url)
      if (!workspace) {
            sendError(res, 400, 'workspace query parameter is required')
            return
          }
      const id = subagentMatch[1]!
      if (!isSessionId(id)) {
            sendError(res, 400, 'invalid subagent id')
            return
          }
      const events = await readSubagentEvents(workspace, id, workspaceSubagentRoot(workspace)).catch(error => {
            if (error instanceof SubagentError) return undefined
            throw error
          })
      if (!events) {
            sendError(res, 404, 'subagent not found')
            return
          }
      sendJson(res, 200, { id, events })
      return
    },
  },
{
    match: (req, url) => {
      const questionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/questions(?:\/([^/]+))?$/)
      return Boolean(questionMatch)
    },
    handle: async (req, res, url, context) => {
      const questionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/questions(?:\/([^/]+))?$/)
      if (!(questionMatch)) return
      const id = questionMatch[1]!
      const workspace = workspaceParam(url)
      if (!workspace || !isSessionId(id)) {
            sendError(res, 400, 'workspace and valid session id are required')
            return
          }
      await readSessionSummary(workspace, id)
      const key = runKey(workspace, id)
      if (req.method === 'GET' && !questionMatch[2]) {
            const log = new SessionLog(sessionFilePath(workspace, id))
            try {
              await log.init()
              const questions = pendingQuestionsFromEvents(await log.read())
                .filter(question => question.agentId === id && (question.mode === 'nonblocking' || isActive(context.activeRuns, workspace, id)))
              sendJson(res, 200, { questions })
            } finally { await log.close() }
            return
          }
      if (req.method === 'POST' && questionMatch[2]) {
            const body = await readJsonBody(req)
            let entry = context.residentAgents?.get(key)
            let root = entry?.root ?? context.questionRoots?.get(key)
            if (!root) {
              const request = await residentQuestionRequest(context, workspace, id)
              entry = await ensureResidentAgent(context, workspace, id, request)
              root = entry.root
            }
            try {
              const answer = await root.userQuestions.answer(questionMatch[2], body.answers, { agentId: id })
              let resumeQueued = false
              if (answer.mode === 'nonblocking') {
                if (entry) {
                  // A manual-streaming Agent needs the existing SSE/approval channel to drain idle work.
                  resumeQueued = entry.agent.status === 'idle' || !isActive(context.activeRuns, workspace, id)
                } else {
                  resumeQueued = true
                }
              }
              sendJson(res, 200, { accepted: true, resumeQueued })
            } catch (error) {
              if (!(error instanceof UserQuestionError)) throw error
              sendError(res, error.code === 'QUESTION_ALREADY_SETTLED' ? 409 : 400, error.message)
            }
            return
          }
    },
  },
{
    match: (req, url) => {
      const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/([^/]+))?$/)
      return Boolean(sessionMatch)
    },
    handle: async (req, res, url, context) => {
      const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/([^/]+))?$/)
      if (!(sessionMatch)) return
      const id = sessionMatch[1]!
      const action = sessionMatch[2]
      const workspace = workspaceParam(url)
      if (!isSessionId(id)) {
            sendError(res, 400, 'invalid session id')
            return
          }
      if (!workspace) {
            sendError(res, 400, 'workspace query parameter is required')
            return
          }
      if (action === undefined && req.method === 'GET') {
            // History is read asynchronously. If a run finishes during this read,
            // this snapshot may not contain its final reply yet; let clients poll again.
            const runningAtReadStart = isActive(context.activeRuns, workspace, id)
            // One config read and one pass over the log: this used to read the session
            // file five times and build an agent runtime just to see its events.
            const config = await readSystemConfig(context.configFile)
            const beforeSeq = optionalSeq(url.searchParams.get('beforeSeq'))
            const maxMessages = optionalCount(url.searchParams.get('maxMessages'))
            const snapshot = await readSessionSnapshot(workspace, id, model =>
              effectiveLlmConfig(config, process.env, model).contextWindow, {
              ...(beforeSeq !== undefined ? { beforeSeq } : {}),
              ...(maxMessages !== undefined ? { maxMessages } : {}),
            })
            sendJson(res, 200, {
              summary: snapshot.summary,
              events: snapshot.events,
              page: snapshot.page,
              context: snapshot.context,
              metrics: snapshot.metrics,
              usage: sessionUsage(snapshot.log, config),
              running: runningAtReadStart || isActive(context.activeRuns, workspace, id),
              ...recoveryField(snapshot.log),
            })
            return
          }
      if (action === 'recover' && req.method === 'POST') {
            if (isActive(context.activeRuns, workspace, id)) {
              sendError(res, 409, 'session is running')
              return
            }
            const entry = context.residentAgents?.get(runKey(workspace, id))
              ?? await ensureResidentAgent(context, workspace, id, await residentQuestionRequest(context, workspace, id))
            // The queued input is durable: the client's resumed run drains it.
            sendJson(res, 200, { resumeQueued: await recoverInterruptedTurn(entry.agent) })
            return
          }
      if (action === 'subagents' && req.method === 'GET') {
            const scope = url.searchParams.get('scope') === 'descendants' ? 'descendants' : 'children'
            const registry = context.residentAgents?.get(runKey(workspace, id))?.registry
            const children = await listStoredSubagents(workspace, id, scope, registry, workspaceSubagentRoot(workspace))
            sendJson(res, 200, { subagents: children })
            return
          }
      if (action === 'jobs' && (req.method === 'GET' || req.method === 'POST')) {
            if (!existsSync(sessionFilePath(workspace, id))) {
              sendError(res, 404, 'session not found')
              return
            }
            const entry = context.residentAgents?.get(runKey(workspace, id))
            const jobs: JobRegistry | undefined = entry?.root.get('jobs')
            if (req.method === 'GET' && !url.searchParams.has('job_id')) {
              sendJson(res, 200, { jobs: jobs && entry ? jobs.list(entry.agent) : [] })
              return
            }
            const body = req.method === 'POST' ? await readJsonBody(req) : undefined
            if (body && (body.action !== 'stop' || typeof body.job_id !== 'string' || !body.job_id.trim())) {
              sendError(res, 400, 'action=stop and job_id are required')
              return
            }
            const jobId = body?.job_id ?? url.searchParams.get('job_id')
            if (typeof jobId !== 'string' || !jobId.trim()) {
              sendError(res, 400, 'job_id is required')
              return
            }
            if (!jobs || !entry || !jobs.list(entry.agent).some(job => job.id === jobId)) {
              sendError(res, 404, 'background job not found')
              return
            }
            sendJson(res, 200, body
              ? { job: jobs.kill(jobId, entry.agent, 'Stopped by user') }
              : jobs.read(jobId, entry.agent))
            return
          }
      if (action === 'goal' && req.method === 'GET') {
            const log = new SessionLog(sessionFilePath(workspace, id))
            await log.init()
            try {
              sendJson(res, 200, { goal: await readGoal(log) ?? null })
            } finally {
              await log.close()
            }
            return
          }
      if (action === undefined && req.method === 'PATCH') {
            const running = isActive(context.activeRuns, workspace, id)
            const body = await readJsonBody(req)
            const patch: Parameters<typeof patchSessionMeta>[2] = {}
            const permission = body.permission === 'workspace-write' || body.permission === 'bypass'
              ? body.permission : body.permission === 'read-only' ? 'read-only' : undefined
            const approvalMode = body.approvalMode === 'auto' || body.approvalMode === 'manual' ? body.approvalMode : undefined
            if (typeof body.title === 'string') patch.title = body.title
            if (isAgentType(body.agentType)) patch.agentType = body.agentType
            if (body.mode === 'auto' || body.mode === 'plan' || body.mode === 'goal') {
              patch.mode = body.mode
            }
            if (typeof body.model === 'string' && body.model.trim()) patch.model = body.model.trim()
            if (body.reasoningEffort === 'default' || body.reasoningEffort === 'low'
              || body.reasoningEffort === 'medium' || body.reasoningEffort === 'high') {
              patch.reasoningEffort = body.reasoningEffort
            }
            if (!Object.keys(patch).length && permission === undefined && approvalMode === undefined) {
              sendError(res, 400, 'session metadata is required')
              return
            }
            // The agent type and the mode shape the whole run; the model, effort,
            // permission and approvals are read again at every step, so they can
            // change while a turn runs and apply from its next step.
            if (running && (patch.agentType !== undefined || patch.mode !== undefined)) {
              sendError(res, 409, 'session is running: change the agent or mode after the current turn ends')
              return
            }
            const previous = await readSessionSummary(workspace, id)
            // Choosing what is already in force is not a change: it writes nothing,
            // so the transcript does not report it either.
            if (patch.model !== undefined && patch.model === previous.model) delete patch.model
            if (patch.reasoningEffort !== undefined && patch.reasoningEffort === (previous.reasoningEffort ?? 'default')) {
              delete patch.reasoningEffort
            }
            // A resident runtime snapshots the permission it was built with, so a
            // permission-only change has to retire it too. A running turn keeps its
            // runtime: the next run sees the new signature and rebuilds it then.
            if (!running && (Object.keys(patch).length || permission !== undefined)) await evictResident(context, workspace, id)
            if (Object.keys(patch).length) await patchSessionMeta(workspace, id, patch)
            if (approvalMode) await setSessionApprovalMode(workspace, id, approvalMode)
            const summary = permission === undefined
              ? await readSessionSummary(workspace, id)
              : await setSessionPermission(workspace, id, permission)
            // Mid-turn, the next step tells the model (see @tnega/run-settings).
            if (permission !== undefined && !running) await appendPermissionNotice(workspace, id)
            sendJson(res, 200, { summary })
            return
          }
      if (action === undefined && req.method === 'DELETE') {
            if (isActive(context.activeRuns, workspace, id)) {
              sendError(res, 409, 'session is running')
              return
            }
            await evictResident(context, workspace, id)
            await deleteSession(workspace, id)
            res.writeHead(204)
            res.end()
            return
          }
      if (action === 'fork' && req.method === 'POST') {
            const body = await readJsonBody(req)
            const summary = await forkSession(workspace, id, {
              ...(typeof body.title === 'string' ? { title: body.title } : {}),
              ...(typeof body.messageId === 'string' && body.messageId
                ? { messageId: body.messageId }
                : {}),
            })
            sendJson(res, 201, { session: summary })
            return
          }
      if (action === 'truncate' && req.method === 'POST') {
            if (isActive(context.activeRuns, workspace, id)) {
              sendError(res, 409, 'session is running')
              return
            }
            await evictResident(context, workspace, id)
            const body = await readJsonBody(req)
            if (typeof body.messageId !== 'string' || !body.messageId) {
              sendError(res, 400, 'messageId is required')
              return
            }
            const summary = await truncateSessionAt(workspace, id, body.messageId)
            sendJson(res, 200, { summary })
            return
          }
      if (action === 'compact' && req.method === 'POST') {
            if (isActive(context.activeRuns, workspace, id)) {
              sendError(res, 409, 'session is running')
              return
            }
            await evictResident(context, workspace, id)
            const body = await readJsonBody(req)
            const keep = typeof body.keep === 'number' && Number.isFinite(body.keep)
              ? body.keep
              : 0
            const summary = await compactContext(context, workspace, id, keep)
            sendJson(res, 200, { summary })
            return
          }
      if (action === 'stop' && req.method === 'POST') {
            await handleStopRun(context, workspace, id)
            sendJson(res, 200, { stopped: true })
            return
          }
      if (action === 'steer' && req.method === 'POST') {
            const body = await readJsonBody(req, MAX_RUN_BODY_BYTES)
            const attachments = parseRunAttachments(body.attachments)
            if (typeof attachments === 'string') {
              sendError(res, 400, attachments)
              return
            }
            const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
            if (!prompt && !attachments.length) {
              sendError(res, 400, 'prompt is required')
              return
            }
            const key = runKey(workspace, id)
            const ready = context.steeringReady.get(key)
            if (ready && !await ready) {
              sendError(res, 409, 'session failed to start')
              return
            }
            const entry = context.residentAgents?.get(key)
            const inbox = context.questionInboxes?.get(key)
            if (!isActive(context.activeRuns, workspace, id) || (!entry && !inbox) || entry?.agent.status === 'idle') {
              sendError(res, 409, 'session has no active run to steer')
              return
            }
            const requestId = submissionId(body.requestId)
            if (entry) await entry.agent.steer({ text: prompt, attachments, ...(requestId ? { requestId } : {}) })
            else if (inbox) await inbox.steer({ text: prompt, ...(attachments.length ? { content: [userMessage(prompt, attachments)] } : {}) })
            sendJson(res, 200, { accepted: true })
            return
          }
      if (action === 'runs' && req.method === 'POST') {
            await handleRun(req, res, context, workspace, id)
            return
          }
    },
  },
]

export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  context: ServerContext,
): Promise<void> {
  for (const route of apiRoutes) {
    if (!route.match(req, url)) continue
    await route.handle(req, res, url, context)
    return
  }
  sendError(res, 404, 'not found')
}


export { isLoopbackAddress } from '@tnega/web-kit'

export async function projectHostFor(
  context: ServerContext,
  workspace: string,
): Promise<ProjectHost> {
  // Project 的文件夹就是它的工作位置，可能是刚为它新建的，所以这里建而不是要求已存在。
  const path = resolve(workspace)
  await mkdir(path, { recursive: true })
  const config = await readSystemConfig(context.configFile)
  const effective = effectiveLlmConfig(config, process.env)
  const apiKey = effectiveApiKey(config, process.env, effective.modelId) ?? ''
  const signature = [
    path,
    effective.baseUrl,
    effective.model,
    apiKey,
    effective.reasoningEffort ?? '',
    context.projectPermission,
    JSON.stringify(config.approvalReview ?? {}),
    JSON.stringify(config.projectMemory ?? {}),
    JSON.stringify(config.models ?? []),
    config.codeMode ? 'ptc' : 'native',
  ].join('|')
  const existing = context.projectHosts?.get(path)
  if (existing?.signature === signature) return existing.host
  if (existing) {
    context.projectHosts?.delete(path)
    await existing.host.dispose()
  }
  const host = new ProjectHost({
    ...(context.ptcRuntime ? { ptcRuntime: context.ptcRuntime } : {}),
    workspace: path,
    llm: adapterFromConfig(effective, apiKey),
    ...(effective.contextWindow !== undefined ? { contextWindow: effective.contextWindow } : {}),
    permission: context.projectPermission,
    approvals: context.approvals,
    systemConfig: config,
    builtinTools: {
      cwd: path,
      processes: processesFor(context, path),
      allowNetwork: true,
      allowShell: true,
      allowOutsideWorkspace: context.projectPermission === 'bypass',
      allowPrivateNetwork: context.projectPermission === 'bypass',
    },
  })
  context.projectHosts?.set(path, { host, signature })
  return host
}

export function configSnapshot(config: SystemConfig, path = systemConfigPath()): Record<string, unknown> {
  const effective = effectiveLlmConfig(config)
  const env = resolveLlmEnv(process.env)
  return {
    apiKeySet: effective.apiKeySet,
    effective: {
      baseUrl: effective.baseUrl,
      model: effective.model,
      modelId: effective.modelId,
      ...(effective.protocol ? { protocol: effective.protocol } : {}),
      ...(effective.reasoningEffort ? { reasoningEffort: effective.reasoningEffort } : {}),
      ...(effective.temperature !== undefined
        ? { temperature: effective.temperature }
        : {}),
      ...(effective.contextWindow !== undefined ? { contextWindow: effective.contextWindow } : {}),
    },
    shell: {
      active: systemShell().label,
      available: availableShells().map(shell => ({ path: shell.path, label: shell.label, kind: shell.kind })),
    },
    network: {
      allowedHosts: config.network?.allowedHosts ?? [],
      proxy: config.network?.proxy ?? '',
      defaultAllowedHosts: DEFAULT_ALLOWED_HOSTS,
      ...(environmentProxy() ? { environmentProxy: environmentProxy() } : {}),
    },
    config: {
      apiKeySet: Boolean(config.apiKey),
      codeMode: config.codeMode ?? false,
      fsGuard: config.fsGuard ?? 'warn',
      projectMemory: { ...PROJECT_MEMORY_DEFAULTS, ...config.projectMemory },
      memoryDream: { ...MEMORY_DREAM_DEFAULTS, ...config.memoryDream },
      shell: config.shell ?? '',
      path,
      approvalReview: {
        provider: config.approvalReview?.provider ?? 'conversation',
        defaultMode: config.approvalReview?.defaultMode ?? 'manual',
        modelId: config.approvalReview?.modelId ?? '',
        model: config.approvalReview?.model ?? '',
        baseUrl: config.approvalReview?.baseUrl ?? '',
        apiKeyEnv: config.approvalReview?.apiKeyEnv ?? '',
        apiKeySet: Boolean(config.approvalReview?.apiKey || process.env[config.approvalReview?.apiKeyEnv || (config.approvalReview?.provider === 'jev' ? 'TYPESAFE_API_KEY' : 'OPENAI_API_KEY')]),
      },
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      ...(config.model ? { model: config.model } : {}),
      ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
      ...(config.protocol ? { protocol: config.protocol } : {}),
      ...(config.temperature !== undefined
        ? { temperature: config.temperature }
        : {}),
      ...(config.contextWindow !== undefined ? { contextWindow: config.contextWindow } : {}),
      models: config.models?.map(model => ({
        id: model.id,
        ...(model.model ? { model: model.model } : {}),
        ...(model.name ? { name: model.name } : {}),
        ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
        ...(model.protocol ? { protocol: model.protocol } : {}),
        ...(model.apiKeyEnv ? { apiKeyEnv: model.apiKeyEnv } : {}),
        apiKeySet: Boolean(model.apiKey || model.apiKeyEnv && process.env[model.apiKeyEnv]),
        ...(model.reasoningEfforts ? { reasoningEfforts: model.reasoningEfforts } : {}),
        ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
        ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
        ...(model.vision !== undefined ? { vision: model.vision } : {}),
        ...(model.pricing ? { pricing: model.pricing } : {}),
        ...(model.auth ? { auth: model.auth } : {}),
        ...(model.source ? { source: model.source } : {}),
      })) ?? [],
    },
    env: {
      apiKeySet: Boolean(env.apiKey),
      ...(env.baseUrl ? { baseUrl: env.baseUrl } : {}),
      ...(env.model ? { model: env.model } : {}),
    },
    models: availableModels(config),
  }
}





export async function compactContext(
  context: ServerContext,
  workspace: string,
  id: string,
  keep: number,
): Promise<SessionSummary> {
  const sessionSummary = await readSessionSummary(workspace, id)
  const config = await readSystemConfig(context.configFile)
  const effective = effectiveLlmConfig(config, process.env, sessionSummary.model)
  const capabilities = availableModels(config).find(model => model.id === effective.modelId)
    ?? modelCapabilities(effective.model, effective.protocol)
  const selectedEffort = sessionSummary.reasoningEffort === 'default'
    ? effective.reasoningEffort : sessionSummary.reasoningEffort ?? effective.reasoningEffort
  if (selectedEffort && capabilities.reasoningEfforts.includes(selectedEffort)) {
    effective.reasoningEffort = selectedEffort
  } else {
    delete effective.reasoningEffort
  }
  const apiKey = effectiveApiKey(config, process.env, effective.modelId)
  if (!effective.apiKeySet || !apiKey) {
    throw new HttpError(400, 'API key is not configured')
  }
  const preparation = await prepareSessionCompact(workspace, id, KEEP_RECENT_TOKENS)
  const hasPrefix = preparation.prefixMessages.length > 0
  const messages = hasPrefix
    ? preparation.prefixMessages
    : await readSessionMessages(workspace, id)
  const previousSummary = hasPrefix ? preparation.previousSummary : undefined
  if (!messages.length) {
    return compactSession(workspace, id, { keep })
  }
  const adapter = compactionAdapter(effective, apiKey)
  const completion = await adapter.complete(
    [
      {
        role: 'system',
        content: SUMMARIZATION_SYSTEM_PROMPT,
      },
      {
        role: 'user',
        content: buildCompactionPrompt(messages, previousSummary),
      },
    ],
    [],
    {},
  )
  const summary = completion.content?.trim()
  if (!summary) throw new HttpError(500, 'compression returned no summary')
  const result = await compactSession(
    workspace,
    id,
    {
      ...(hasPrefix ? { keepTokens: KEEP_RECENT_TOKENS } : { keep }),
      checkpointMessages: [
        { role: 'system', content: `${SUMMARY_PREFIX}${summary}` },
      ],
      summary,
      tokensBefore: preparation.tokensBefore,
    },
  )
  const memoryRoot = new Context()
  try {
    await memoryRoot.plugin(memoryLocal, { cwd: workspace })
    const memory = memoryRoot.get('memory')
    try {
      await consolidateProjectMemory(memory, adapter, summary, messages)
    } catch (error) {
      memoryRoot.logger.warn(`project memory update failed after compaction: ${errorMessage(error)}`)
    }
  } finally {
    await memoryRoot.fiber.dispose()
  }
  return result
}

export function environmentProxy(): string | undefined {
  const raw = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy ?? process.env.ALL_PROXY ?? process.env.all_proxy
  if (!raw?.trim()) return undefined
  try {
    const url = new URL(raw.trim())
    return `${url.protocol}//${url.host}`
  } catch {
    return undefined
  }
}

export function applyNetwork(config: SystemConfig, hostFetch: typeof fetch | undefined): void {
  configureNetwork({ ...config.network, ...(hostFetch ? { fetch: hostFetch } : {}) })
}
