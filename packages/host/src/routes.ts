import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { IncomingMessage, ServerResponse } from 'node:http'
import { dedupe, errorMessage, readJsonBody, sendError, sendJson, writeSse, HttpError } from './http.js'
import { KEEP_RECENT_TOKENS, MAX_RUN_BODY_BYTES, adapterFromConfig, canonicalWorkspace, compactionAdapter, isActive, optionalCount, optionalSeq, parseRunAttachments, processesFor, runKey, sessionFilePath, userMessage, workspaceParam } from './support.js'
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
import { storedWorkspaceUsage } from '@tnega/usage'
import { readWorkspacePrompt, writeWorkspacePrompt } from '@tnega/workspace-prompt'
import { ChatGptLogin } from '@tnega/auth-chatgpt'
import { discoverModels, ModelDiscoveryError, parseModelDiscoveryInput } from '@tnega/config'
import { pendingQuestionsFromEvents, UserQuestionError } from '@tnega/user-questions'
import { readGoal } from '@tnega/goal'
import { FileServeError, readWorkspaceFile, sendFile } from '@tnega/workspace-files'
import { searchWorkspaceFiles } from '@tnega/workspace-files'
import { isAgentType, SessionLog } from '@tnega/session'
import { parseLiveInput } from '@tnega/browser-playwright'
import { availableShells, configureSystemShell, DEFAULT_ALLOWED_HOSTS, systemShell } from '@tnega/execution'
import { listStoredSubagents, readSubagentEvents } from '@tnega/subagent-local'
import { SubagentError } from '@tnega/subagent'
import { JobRegistry } from '@tnega/jobs'
import { ProjectHost } from '@tnega/project-host'
import { workspaceSubagentRoot } from '@tnega/home'
import { defaultWorkspace } from '@tnega/home'
import { handleProjectApi } from '@tnega/project-http'
import { pickSystemFolder } from '@tnega/directory-picker'
import { listDirectory, MAX_TEXT_FILE_BYTES, readTextFile, writeTextFile } from '@tnega/workspace-files'
import { fileDiff, listChanges } from '@tnega/workspace-files'
import { TerminalError, TerminalManager, type TerminalEvent } from '@tnega/terminal'
import { resolveLlmEnv } from '@tnega/config'
import { effectiveApiKey, effectiveLlmConfig, availableModels, readSystemConfig, systemConfigPath, systemConfigProblem, updateSystemConfig, normalizeApprovalReviewer, normalizeProjectMemory, PROJECT_MEMORY_DEFAULTS, ModelRouteError, parseModelRouteInput, parseNetworkConfig, removeModelRoute, upsertModelRoute, type SystemConfig, type SystemConfigPatch } from '@tnega/config'
import { createSession, deleteSession, ensureWorkspace, forkSession, isSessionId, listSessions, patchSessionMeta, readSessionSnapshot, readSessionSummary, setSessionPermission, setSessionApprovalMode, truncateSessionAt } from '@tnega/session-store'
import type { ServerContext } from './context.js'
import { evictResident, ensureResidentAgent, submissionId, recoveryField, residentQuestionRequest, handleRun, handleCodingCommands, handleCodingSlash, handleCodingSlashCandidates, handleStopRun } from './runs.js'
import type { WebServerService } from './web-server.js'

export const CHATGPT_DEFAULT_MODEL = 'gpt-5-codex'

/**
 * Routes that no longer live in `handleApi`'s if-chain. Each one is registered
 * by name, and the table's fixed matching order (exact before prefix) keeps
 * them ahead of the `/api/` catch-all that still serves the untouched domains.
 */
export function registerApiRoutes(web: WebServerService, context: ServerContext): void {
  web.register({
    kind: 'exact',
    method: 'GET',
    path: '/api/health',
    handler: (_req, res) => {
      sendJson(res, 200, { ok: true })
    },
  })
  web.register({
    kind: 'exact',
    method: 'GET',
    path: '/api/plugins',
    handler: async (_req, res) => {
      const workshop = context.pluginWorkshop
      sendJson(res, 200, {
        ...(context.hotPlugins ? { enabled: true, ...context.hotPlugins.status() } : { enabled: false }),
        dev: workshop
          ? { enabled: true, dir: workshop.dir, ...workshop.host.status(), plugins: (await workshop.list()).map(plugin => plugin.name) }
          : { enabled: false },
      })
    },
  })
  web.register({
    kind: 'exact',
    method: 'POST',
    path: '/api/plugins/reload',
    handler: async (_req, res) => {
      if (!context.hotPlugins) {
        sendError(res, 404, 'plugin profile is not enabled')
        return
      }
      sendJson(res, 200, { enabled: true, ...await context.hotPlugins.reload() })
    },
  })
  web.register({
    kind: 'exact',
    method: 'POST',
    path: '/api/folder-picker',
    handler: async (req, res) => {
      if (!isLoopbackAddress(req.socket.remoteAddress)) {
        sendError(res, 403, 'folder picker is only available to local clients')
        return
      }
      const path = await pickSystemFolder()
      sendJson(res, 200, path ? { path } : {})
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

export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  context: ServerContext,
): Promise<void> {
  if (url.pathname === '/api/projects' || url.pathname.startsWith('/api/projects/')) {
    await handleProjectApi(req, res, url, {
      host: workspace => projectHostFor(context, workspace),
      sendJson,
      sendError,
      readJsonBody,
      writeSse,
      workspaceParam,
    })
    return
  }

  const approvalMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/approvals\/([^/]+)$/)
  if (approvalMatch && req.method === 'POST') {
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
  }

  if (url.pathname === '/api/config' && req.method === 'GET') {
    const config = await readSystemConfig(context.configFile)
    const problem = await systemConfigProblem(context.configFile)
    sendJson(res, 200, { ...configSnapshot(config, context.configFile), ...(problem ? { problem } : {}) })
    return
  }

  if (url.pathname === '/api/config' && req.method === 'PUT') {
    const body = await readJsonBody(req)
    const patch: SystemConfigPatch = {}
    if (body.codeMode !== undefined) {
      if (typeof body.codeMode !== 'boolean') { sendError(res, 400, 'codeMode must be a boolean'); return }
      patch.codeMode = body.codeMode
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
  }

  if (url.pathname === '/api/config/models/discover' && req.method === 'POST') {
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
  }

  // Chat model routes: register several and choose one per session or as the default.
  const modelRoute = /^\/api\/config\/models\/([^/]+)$/.exec(url.pathname)
  if (modelRoute && (req.method === 'PUT' || req.method === 'DELETE')) {
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
  }

  if (url.pathname.startsWith('/api/browser')) {
    await handleBrowser(req, res, url, context)
    return
  }

  // ChatGPT sign-in: start opens the callback server and returns the URL to open.
  if (url.pathname === '/api/auth/chatgpt') {
    const login = context.chatgptLogin ??= new ChatGptLogin({
      onSignedIn: async () => {
        const config = await readSystemConfig(context.configFile)
        if (!config.models?.some(route => route.auth === 'chatgpt')) {
          await upsertModelRoute('chatgpt', { model: CHATGPT_DEFAULT_MODEL, name: `ChatGPT · ${CHATGPT_DEFAULT_MODEL}`, auth: 'chatgpt' }, context.configFile)
        }
      },
    })
    if (req.method === 'GET') { sendJson(res, 200, await login.state()); return }
    if (req.method === 'POST') {
      try {
        sendJson(res, 200, await login.start())
      } catch (error) {
        sendError(res, 409, errorMessage(error))
      }
      return
    }
    if (req.method === 'DELETE') { await login.signOut(); sendJson(res, 200, await login.state()); return }
  }

  if (url.pathname === '/api/usage' && req.method === 'GET') {
    const workspace = workspaceParam(url)
    if (!workspace) { sendError(res, 400, 'workspace query parameter is required'); return }
    sendJson(res, 200, await storedWorkspaceUsage(workspace, await readSystemConfig(context.configFile)))
    return
  }

  if (url.pathname === '/api/workspace-prompt' && (req.method === 'GET' || req.method === 'PUT')) {
    const workspace = workspaceParam(url)
    if (!workspace) { sendError(res, 400, 'workspace query parameter is required'); return }
    if (req.method === 'PUT') {
      const body = await readJsonBody(req)
      if (typeof body.prompt !== 'string' || body.prompt.length > 32000) {
        sendError(res, 400, 'prompt must be a string of at most 32000 characters'); return
      }
      await writeWorkspacePrompt(workspace, body.prompt)
    }
    sendJson(res, 200, { prompt: await readWorkspacePrompt(workspace) })
    return
  }

  if (url.pathname === '/api/processes' && (req.method === 'GET' || req.method === 'POST')) {
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
  }

  if (url.pathname === '/api/workspaces' && req.method === 'GET') {
    const config = await readSystemConfig(context.configFile)
    const fallback = defaultWorkspace()
    await mkdir(fallback, { recursive: true })
    sendJson(res, 200, { workspaces: config.workspaces ?? [], defaultWorkspace: await ensureWorkspace(fallback) })
    return
  }

  if (url.pathname === '/api/workspaces' && req.method === 'POST') {
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
  }

  if (url.pathname === '/api/workspaces' && req.method === 'DELETE') {
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
  }

  if (url.pathname === '/api/files/search' && req.method === 'GET') {
    const workspace = workspaceParam(url)
    if (!workspace) {
      sendError(res, 400, 'workspace query parameter is required')
      return
    }
    const limit = Number(url.searchParams.get('limit') ?? 30)
    const files = await searchWorkspaceFiles(workspace, url.searchParams.get('q') ?? '', Number.isFinite(limit) ? limit : 30)
    sendJson(res, 200, { files })
    return
  }

  if (url.pathname === '/api/changes' || url.pathname === '/api/changes/file') {
    const workspace = workspaceParam(url)
    if (!workspace || req.method !== 'GET') {
      sendError(res, workspace ? 405 : 400, workspace ? 'method not allowed' : 'workspace query parameter is required')
      return
    }
    try {
      if (url.pathname === '/api/changes') {
        sendJson(res, 200, await listChanges(workspace))
      } else {
        const path = url.searchParams.get('path')
        if (!path) {
          sendError(res, 400, 'path query parameter is required')
          return
        }
        sendJson(res, 200, await fileDiff(workspace, path))
      }
    } catch (error) {
      if (!(error instanceof FileServeError)) throw error
      sendError(res, error.status, error.message)
    }
    return
  }

  const terminalMatch = url.pathname.match(/^\/api\/terminals(?:\/([^/]+)(?:\/(stream|input|resize))?)?$/)
  if (terminalMatch) {
    try {
      await handleTerminal(req, res, url, context.terminals, terminalMatch[1], terminalMatch[2])
    } catch (error) {
      if (!(error instanceof TerminalError)) throw error
      if (!res.headersSent) sendError(res, error.status, error.message)
    }
    return
  }

  if (url.pathname === '/api/files/tree' || url.pathname === '/api/files/text') {
    const workspace = workspaceParam(url)
    const path = url.searchParams.get('path') ?? ''
    if (!workspace) {
      sendError(res, 400, 'workspace query parameter is required')
      return
    }
    try {
      if (url.pathname === '/api/files/tree' && req.method === 'GET') {
        sendJson(res, 200, { path, entries: await listDirectory(workspace, path) })
      } else if (url.pathname === '/api/files/text' && req.method === 'GET' && path) {
        sendJson(res, 200, await readTextFile(workspace, path))
      } else if (url.pathname === '/api/files/text' && req.method === 'PUT' && path) {
        const body = await readJsonBody(req, MAX_TEXT_FILE_BYTES * 2)
        if (typeof body.content !== 'string') {
          sendError(res, 400, 'content must be a string')
          return
        }
        const expected = typeof body.mtimeMs === 'number' ? body.mtimeMs : undefined
        sendJson(res, 200, await writeTextFile(workspace, path, body.content, expected))
      } else {
        sendError(res, path ? 405 : 400, path ? 'method not allowed' : 'path query parameter is required')
      }
    } catch (error) {
      if (!(error instanceof FileServeError)) throw error
      sendError(res, error.status, error.message)
    }
    return
  }

  if (url.pathname === '/api/files' && req.method === 'GET') {
    const workspace = workspaceParam(url)
    const path = url.searchParams.get('path')
    if (!workspace || !path) {
      sendError(res, 400, 'workspace and path query parameters are required')
      return
    }
    try {
      sendFile(res, await readWorkspaceFile(workspace, path))
    } catch (error) {
      if (!(error instanceof FileServeError)) throw error
      sendError(res, error.status, error.message)
    }
    return
  }

  if (url.pathname === '/api/sessions' && req.method === 'GET') {
    const workspace = workspaceParam(url)
    if (!workspace) {
      sendError(res, 400, 'workspace query parameter is required')
      return
    }
    const sessions = await listSessions(workspace)
    sendJson(res, 200, { workspace, sessions })
    return
  }

  if (url.pathname === '/api/sessions' && req.method === 'POST') {
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
  }

  const codingMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/coding\/(commands|slash|slash-candidates)$/)
  if (codingMatch) {
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
  }

  const subagentMatch = url.pathname.match(/^\/api\/subagents\/([^/]+)$/)
  if (subagentMatch && req.method === 'GET') {
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
  }

  const questionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/questions(?:\/([^/]+))?$/)
  if (questionMatch) {
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
  }

  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/([^/]+))?$/)
  if (sessionMatch) {
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
      if (isActive(context.activeRuns, workspace, id)) {
        sendError(res, 409, 'session is running')
        return
      }
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
      if (Object.keys(patch).length) await evictResident(context, workspace, id)
      if (Object.keys(patch).length) await patchSessionMeta(workspace, id, patch)
      if (approvalMode) await setSessionApprovalMode(workspace, id, approvalMode)
      const summary = permission === undefined
        ? await readSessionSummary(workspace, id)
        : await setSessionPermission(workspace, id, permission)
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
  }

  sendError(res, 404, 'not found')
}

export function isLoopbackAddress(address: string | undefined): boolean {
  return address === '::1' || address === '::ffff:127.0.0.1'
    || address?.startsWith('127.') === true
    || address?.startsWith('::ffff:127.') === true
}

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
      projectMemory: { ...PROJECT_MEMORY_DEFAULTS, ...config.projectMemory },
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

export async function handleBrowser(req: IncomingMessage, res: ServerResponse, url: URL, context: ServerContext): Promise<void> {
  const browser = context.browser
  if (url.pathname === '/api/browser' && req.method === 'GET') {
    sendJson(res, 200, { available: Boolean(browser), state: browser?.state(), tabs: browser?.tabs() ?? [] })
    return
  }
  if (!browser) {
    sendError(res, 404, 'the agent browser is disabled')
    return
  }
  if (url.pathname === '/api/browser/live' && req.method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    writeSse(res, { type: 'state', ...browser.state() })
    writeSse(res, { type: 'tabs', tabs: browser.tabs() })
    let pending = false
    const unsubscribe = browser.live.subscribe(event => {
      if (res.destroyed || res.writableEnded) return
      // Drop frames while the socket is still flushing the previous one.
      if (event.type === 'frame' && pending) return
      pending = !res.write(`event: ${event.type}
data: ${JSON.stringify(event)}

`)
    }, { frames: url.searchParams.get('frames') !== '0' })
    res.on('drain', () => { pending = false })
    req.on('close', unsubscribe)
    return
  }
  if (url.pathname === '/api/browser/input' && req.method === 'POST') {
    const input = parseLiveInput(await readJsonBody(req))
    if (!input) {
      sendError(res, 400, 'invalid browser input')
      return
    }
    await browser.live.input(input)
    sendJson(res, 200, { ok: true })
    return
  }
  if (url.pathname === '/api/browser/navigate' && req.method === 'POST') {
    const body = await readJsonBody(req)
    if (typeof body.url !== 'string' || !body.url.trim()) {
      sendError(res, 400, 'url is required')
      return
    }
    await browser.userNavigate(body.url)
    sendJson(res, 200, browser.state())
    return
  }
  if (url.pathname === '/api/browser/viewport' && req.method === 'POST') {
    const body = await readJsonBody(req)
    const width = Number(body.width)
    const height = Number(body.height)
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width > 8000 || height > 8000) {
      sendError(res, 400, 'width and height must be positive numbers')
      return
    }
    await browser.setViewport(width, height)
    sendJson(res, 200, { ok: true })
    return
  }
  if (url.pathname === '/api/browser/tabs' && req.method === 'POST') {
    const body = await readJsonBody(req)
    const id = typeof body.id === 'string' ? body.id : undefined
    if (body.action === 'new') await browser.newTab(typeof body.url === 'string' && body.url.trim() ? body.url : undefined)
    else if (body.action === 'select' && id) await browser.selectTab(id)
    else if (body.action === 'close') await browser.closeTab(id)
    else {
      sendError(res, 400, 'action must be new, select (with id) or close')
      return
    }
    sendJson(res, 200, { tabs: browser.tabs() })
    return
  }
  if (url.pathname === '/api/browser/pick' && req.method === 'POST') {
    const result = await browser.pick()
    sendJson(res, 200, result ?? { cancelled: true })
    return
  }
  if (url.pathname === '/api/browser/pick/cancel' && req.method === 'POST') {
    await browser.cancelPick()
    sendJson(res, 200, { ok: true })
    return
  }
  if (url.pathname === '/api/browser/command' && req.method === 'POST') {
    const body = await readJsonBody(req)
    if (body.command !== 'back' && body.command !== 'forward' && body.command !== 'reload') {
      sendError(res, 400, 'command must be back, forward or reload')
      return
    }
    await browser.userCommand(body.command)
    sendJson(res, 200, browser.state())
    return
  }
  sendError(res, 404, 'not found')
}

export async function handleTerminal(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  terminals: TerminalManager,
  id: string | undefined,
  action: string | undefined,
): Promise<void> {
  if (!id) {
    const workspace = workspaceParam(url)
    if (req.method === 'GET') {
      sendJson(res, 200, { terminals: terminals.list(workspace ?? undefined) })
    } else if (req.method === 'POST') {
      if (!workspace) {
        sendError(res, 400, 'workspace query parameter is required')
        return
      }
      const body = await readJsonBody(req)
      sendJson(res, 200, await terminals.create(workspace, {
        ...(typeof body.cols === 'number' ? { cols: body.cols } : {}),
        ...(typeof body.rows === 'number' ? { rows: body.rows } : {}),
      }))
    } else {
      sendError(res, 405, 'method not allowed')
    }
    return
  }
  if (!action && req.method === 'DELETE') {
    terminals.close(id)
    sendJson(res, 200, { ok: true })
  } else if (action === 'stream' && req.method === 'GET') {
    const events: TerminalEvent[] = []
    // Attach first so an unknown id fails before the stream opens.
    let open = false
    const send = (event: TerminalEvent) => { if (!res.destroyed && !res.writableEnded) writeSse(res, event) }
    const detach = terminals.attach(id, event => { if (open) send(event); else events.push(event) })
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.flushHeaders()
    open = true
    for (const event of events) send(event)
    req.on('close', detach)
  } else if (action === 'input' && req.method === 'POST') {
    const body = await readJsonBody(req)
    if (typeof body.data !== 'string') {
      sendError(res, 400, 'data must be a string')
      return
    }
    terminals.write(id, body.data)
    sendJson(res, 200, { ok: true })
  } else if (action === 'resize' && req.method === 'POST') {
    const body = await readJsonBody(req)
    if (typeof body.cols !== 'number' || typeof body.rows !== 'number') {
      sendError(res, 400, 'cols and rows must be numbers')
      return
    }
    terminals.resize(id, body.cols, body.rows)
    sendJson(res, 200, { ok: true })
  } else {
    sendError(res, 405, 'method not allowed')
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
