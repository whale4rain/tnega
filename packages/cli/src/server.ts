import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  agents,
  type AgentCreationOptions,
  type AgentHandle,
  type AgentRegistry,
  type AgentStreamEvent,
  type LiveAgent,
} from '@tnega/agent'
import { Context } from '@tnega/core'
import {
  CODING_SYSTEM_PROMPT,
  createCodingAgentPlugin,
  createSlashRegistry,
  generatePlan,
  type CodingService,
  type Plan,
  type SlashCommandResult,
} from '@tnega/coding-agent'
import { createLlmAdapter, modelCapabilities, openaiCompatAdapter } from '@tnega/llm'
import { changeGoal, createGoal, goalTools, readGoal, writeGoal } from './goal.js'
import { memoryLocal } from '@tnega/memory-local'
import type { MemoryService } from '@tnega/memory'
import {
  session,
  SessionLog,
  transcriptEvents,
  type ModelMessage,
  type PlanPayload,
} from '@tnega/session'
import { searchRipgrep } from '@tnega/search-ripgrep'
import { spillLocal } from '@tnega/spill-local'
import { listStoredSubagents, readSubagentEvents, subagentLocal } from '@tnega/subagent-local'
import { SubagentError } from '@tnega/subagent'
import { toolSpill } from '@tnega/tool-spill'
import { toolSearch } from '@tnega/tool-search'
import { toolSubagent } from '@tnega/tool-subagent'
import { consolidateProjectMemory, toolMemory } from '@tnega/tool-memory'
import { builtinTools, tools, type ToolsService } from '@tnega/tools'
import { ApprovalBroker, permissionGuard, type PermissionMode } from './permissions.js'
import { captureFileEditBaseline, captureWritePreimage, editedFiles } from './file-edits.js'
import { webSearchTool } from './web-search.js'
import {
  createAgentRuntime,
  resolveLlmEnv,
  type AgentRuntime,
} from './commands.js'
import {
  effectiveApiKey,
  effectiveLlmConfig,
  availableModels,
  readSystemConfig,
  systemConfigPath,
  updateSystemConfig,
  type EffectiveLlmConfig,
  type SystemConfig,
  type SystemConfigPatch,
} from './config.js'
import {
  compactSession,
  createSession,
  deleteSession,
  ensureWorkspace,
  estimateContextUsage,
  forkSession,
  isSessionId,
  listSessions,
  patchSessionMeta,
  prepareSessionCompact,
  readSessionMessages,
  readSessionMetrics,
  readSessionSummary,
  type SessionSummary,
  setSessionTitle,
  truncateSessionAt,
} from './store.js'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 3080
const MAX_BODY_BYTES = 1024 * 1024
// Independent of the automatic budget's retain ratio on purpose: a manual
// compaction whose surface fits entirely under this budget falls back to
// shadowing the whole surface (`keep` defaults to 0), so raising this value
// past the surface size changes manual compaction from "keep the tail" to
// "summarize everything". Keep it a deliberate choice, not a derived one.
const KEEP_RECENT_TOKENS = 20_000

const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`

const UPDATE_SUMMARIZATION_INSTRUCTIONS = `Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

${UPDATE_SUMMARIZATION_INSTRUCTIONS}`

export interface WebServerOptions {
  port?: number
  host?: string
  webRoot?: string
  configFile?: string
  /** Run auto sessions through resident durable-inbox agents. Defaults to true. */
  resident?: boolean
}

export interface WebServer {
  url: string
  port: number
  close: () => Promise<void>
}

interface ResidentAgentEntry {
  agent: LiveAgent
  registry: AgentRegistry
  tools: ToolsService
  dispose: () => Promise<void>
  signature: string
}

export async function startWebServer(
  options: WebServerOptions = {},
): Promise<WebServer> {
  const host = options.host ?? DEFAULT_HOST
  const port = options.port ?? DEFAULT_PORT
  const webRoot = options.webRoot ?? defaultWebRoot()
  const configFile = options.configFile
  const activeRuns = new Map<string, AbortController>()
  const approvals = new ApprovalBroker()
  const residentAgents = new Map<string, ResidentAgentEntry>()
  let actualPort = port
  const context: ServerContext = {
    webRoot,
    activeRuns,
    approvals,
    resident: options.resident !== false,
    residentAgents,
    ...(configFile ? { configFile } : {}),
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res, context)
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(port, host, () => {
      server.removeListener('error', rejectListen)
      const address = server.address()
      if (address && typeof address === 'object') actualPort = address.port
      resolveListen()
    })
  })

  return {
    url: `http://${host}:${actualPort}`,
    port: actualPort,
    close: async () => {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close(error => error ? rejectClose(error) : resolveClose())
      })
      const entries = [...residentAgents.values()]
      residentAgents.clear()
      await Promise.all(entries.map(entry => entry.dispose()))
    },
  }
}

interface ServerContext {
  webRoot: string
  configFile?: string
  activeRuns: Map<string, AbortController>
  approvals: ApprovalBroker
  resident?: boolean
  residentAgents?: Map<string, ResidentAgentEntry>
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  context: ServerContext,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url, context)
    } else {
      await handleStatic(req, res, url.pathname, context.webRoot)
    }
  } catch (error) {
    if (error instanceof HttpError) {
      sendError(res, error.status, error.message)
      return
    }
    if (!res.headersSent && !res.destroyed) {
      sendError(res, 500, errorMessage(error))
    } else if (!res.destroyed) {
      writeSse(res, { type: 'error', message: errorMessage(error) })
      res.end()
    }
  }
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  context: ServerContext,
): Promise<void> {
  if (req.headers['x-tnega-client'] !== '1') {
    sendError(res, 403, 'missing x-tnega-client header')
    return
  }
  if (
    req.method === 'POST'
    || req.method === 'PUT'
    || req.method === 'PATCH'
  ) {
    const contentType = req.headers['content-type'] ?? ''
    if (!contentType.toLowerCase().startsWith('application/json')) {
      sendError(res, 415, 'content-type must be application/json')
      return
    }
  }

  if (url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true })
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
    sendJson(res, 200, configSnapshot(config, context.configFile))
    return
  }

  if (url.pathname === '/api/config' && req.method === 'PUT') {
    const body = await readJsonBody(req)
    const patch: SystemConfigPatch = {}
    if (typeof body.apiKey === 'string') patch.apiKey = body.apiKey
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
    const config = await updateSystemConfig(patch, context.configFile)
    sendJson(res, 200, configSnapshot(config, context.configFile))
    return
  }

  if (url.pathname === '/api/workspaces' && req.method === 'GET') {
    const config = await readSystemConfig(context.configFile)
    sendJson(res, 200, { workspaces: config.workspaces ?? [] })
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
    const agentType = body.agentType === 'general' || body.agentType === 'coding'
      ? body.agentType
      : undefined
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
    const events = await readSubagentEvents(workspace, id).catch(error => {
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
      const summary = await readSessionSummary(workspace, id)
      const detail = await readSessionEvents(workspace, id)
      const [contextUsage, metrics] = await Promise.all([
        estimateContextUsage(workspace, id),
        readSessionMetrics(workspace, id),
      ])
      sendJson(res, 200, {
        summary,
        events: detail.events,
        surface: detail.surface,
        context: contextUsage,
        metrics,
        running: isActive(context.activeRuns, workspace, id),
      })
      return
    }
    if (action === 'subagents' && req.method === 'GET') {
      const scope = url.searchParams.get('scope') === 'descendants' ? 'descendants' : 'children'
      const registry = context.residentAgents?.get(runKey(workspace, id))?.registry
      const children = await listStoredSubagents(workspace, id, scope, registry)
      sendJson(res, 200, { subagents: children })
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
      if (typeof body.title === 'string') patch.title = body.title
      if (body.agentType === 'general' || body.agentType === 'coding') {
        patch.agentType = body.agentType
      }
      if (body.mode === 'auto' || body.mode === 'plan' || body.mode === 'goal') {
        patch.mode = body.mode
      }
      if (typeof body.model === 'string' && body.model.trim()) patch.model = body.model.trim()
      if (body.reasoningEffort === 'default' || body.reasoningEffort === 'low'
        || body.reasoningEffort === 'medium' || body.reasoningEffort === 'high') {
        patch.reasoningEffort = body.reasoningEffort
      }
      if (!Object.keys(patch).length) {
        sendError(res, 400, 'session metadata is required')
        return
      }
      await evictResident(context, workspace, id)
      const summary = await patchSessionMeta(workspace, id, patch)
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
    if (action === 'runs' && req.method === 'POST') {
      await handleRun(req, res, context, workspace, id)
      return
    }
  }

  sendError(res, 404, 'not found')
}

async function compactContext(
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
  const adapter = createLlmAdapter({
    apiKey,
    baseUrl: effective.baseUrl,
    model: effective.model,
    ...(effective.protocol ? { protocol: effective.protocol } : {}),
    // A thinking model bills its reasoning against this cap, so the budget has
    // to cover the reasoning *plus* the summary it is the point of asking for.
    maxTokens: 8192,
    timeoutMs: 180_000,
    ...(effective.temperature !== undefined
      ? { temperature: effective.temperature }
      : {}),
    ...(effective.reasoningEffort ? { reasoningEffort: effective.reasoningEffort } : {}),
  })
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
        { role: 'system', content: `[compressed conversation]\n${summary}` },
      ],
      summary,
      tokensBefore: preparation.tokensBefore,
    },
  )
  const memoryRoot = new Context()
  try {
    await memoryRoot.plugin(memoryLocal, { cwd: workspace })
    const memory = memoryRoot.get('memory') as MemoryService
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

function buildCompactionPrompt(
  messages: readonly ModelMessage[],
  previousSummary?: string,
): string {
  let prompt = `<conversation>\n${serializeMessages(messages)}\n</conversation>\n\n`
  if (previousSummary) {
    prompt += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`
    prompt += UPDATE_SUMMARIZATION_PROMPT
  } else {
    prompt += SUMMARIZATION_PROMPT
  }
  return prompt
}

function serializeMessages(messages: readonly ModelMessage[]): string {
  const parts: string[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      if (message.content) parts.push(`[User]: ${message.content}`)
    } else if (message.role === 'assistant') {
      const toolCalls: string[] = []
      for (const call of message.tool_calls ?? []) {
        const args = call.arguments && typeof call.arguments === 'object'
          ? Object.entries(call.arguments as Record<string, unknown>)
              .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
              .join(', ')
          : JSON.stringify(call.arguments ?? {})
        toolCalls.push(`${call.name}(${args})`)
      }
      if (message.content) parts.push(`[Assistant]: ${message.content}`)
      if (toolCalls.length) parts.push(`[Assistant tool calls]: ${toolCalls.join('; ')}`)
    } else if (message.role === 'tool') {
      if (message.content) parts.push(`[Tool result]: ${truncateSummaryText(message.content, 2000)}`)
    } else if (message.role === 'system') {
      if (message.content) parts.push(`[System]: ${message.content}`)
    }
  }
  return parts.join('\n\n')
}

function truncateSummaryText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} more characters truncated]`
}

async function handleRun(
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
  const body = await readJsonBody(req)
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
    sendError(res, 400, 'prompt is required')
    return
  }
  const prompt = body.prompt.trim()
  const permission: PermissionMode = body.permission === 'workspace-write' || body.permission === 'bypass'
    ? body.permission : body.allowShell === true ? 'workspace-write' : 'read-only'
  const summary = await readSessionSummary(workspace, id)
  const coding = summary.agentType === 'coding'
  const mode = summary.mode ?? 'auto'

  const config = await readSystemConfig(context.configFile)
  const effective = effectiveLlmConfig(config, process.env, summary.model)
  const capabilities = availableModels(config).find(model => model.id === effective.modelId)
    ?? modelCapabilities(effective.model, effective.protocol)
  const selectedEffort = summary.reasoningEffort === 'default'
    ? effective.reasoningEffort : summary.reasoningEffort ?? effective.reasoningEffort
  if (selectedEffort && capabilities.reasoningEfforts.includes(selectedEffort)) {
    effective.reasoningEffort = selectedEffort
  } else {
    delete effective.reasoningEffort
  }
  if (!effective.apiKeySet) {
    sendError(res, 400, 'API key is not configured')
    return
  }
  const apiKey = effectiveApiKey(config, process.env, effective.modelId)
  if (!apiKey) {
    sendError(res, 400, 'API key is not configured')
    return
  }

  if (context.resident && (mode === 'auto' || mode === 'goal')) {
    await runResidentTurn(context, res, workspace, id, {
      prompt,
      permission,
      sessionId: id,
      approvals: context.approvals,
      coding,
      goalMode: mode === 'goal',
      effective,
      apiKey,
    })
    return
  }

  await evictResident(context, workspace, id)

  const controller = new AbortController()
  const adapter = adapterFromConfig(effective, apiKey)
  let runtime: AgentRuntime | undefined
  try {
    runtime = await createAgentRuntime({
      cwd: workspace,
      sessionFile: sessionFilePath(workspace, id),
      llm: adapter,
      allowNetwork: true,
      allowShell: true,
      builtinTools: {
        cwd: workspace,
        allowNetwork: true,
        allowShell: true,
        allowOutsideWorkspace: permission === 'bypass',
        allowPrivateNetwork: permission === 'bypass',
      },
      ...(coding
        ? {
            plugins: [createCodingAgentPlugin({
              cwd: workspace,
              mode,
              registerAgent: false,
            })],
          }
        : {}),
    })
    const toolService = runtime.root.get('tools') as ToolsService
    toolService.register(webSearchTool(searchApiKey(effective, apiKey)))
    toolService.guard(permissionGuard(permission, runKey(workspace, id), context.approvals, { workspace }))
  } catch (error) {
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
    controller.abort({ type: 'user' })
  })

  let editTracking: { session: SessionLog; startSeq: number; baseline: Awaited<ReturnType<typeof captureFileEditBaseline>> } | undefined

  try {
    const sessionLog = runtime.root.get('session') as SessionLog
    await sessionLog.append('meta', { kind: 'permission/run', mode: permission })
    editTracking = {
      session: sessionLog,
      startSeq: (await sessionLog.read()).at(-1)?.seq ?? 0,
      baseline: await captureFileEditBaseline(workspace),
    }
    const editBaseline = editTracking.baseline
    const toolService = runtime.root.get('tools') as ToolsService
    toolService.guard(async request => {
      if (request.name === 'write_file') await captureWritePreimage(workspace, editBaseline, request.input)
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
        messages: [...history, { role: 'user' as const, content: prompt }],
        signal: controller.signal,
        emit: emitSse,
      })
      await sessionLog.append('user/message', { content: prompt })
      await sessionLog.append('assistant/message', {
        content: [plan.summary ?? 'Plan', ...plan.items.map((item, index) => `${index + 1}. ${item.title}`)].join('\n'),
      })
      await sessionLog.flush()
      await autoTitle(workspace, id, prompt)
      await runtime.dispose()
      runtime = undefined
      if (!res.destroyed && !res.writableEnded) writeSse(res, { type: 'done' })
      return
    }
    // A coding session's first run persists its system prompt as a durable
    // system/message, so a resumed run's derived history already leads with it;
    // prepending it again would duplicate the coding system in the model input
    // (and in the top-level system once Anthropic folds the messages).
    const messages: ModelMessage[] = [
      ...(coding && history[0]?.role !== 'system'
        ? [{ role: 'system' as const, content: CODING_SYSTEM_PROMPT }]
        : []),
      ...history,
      { role: 'user' as const, content: prompt },
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
    await autoTitle(workspace, id, prompt)
    if (!res.destroyed && !res.writableEnded) writeSse(res, { type: 'done' })
  } catch (error) {
    if (!res.destroyed && !res.writableEnded) {
      writeSse(res, { type: 'error', message: errorMessage(error) })
    }
  } finally {
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
    if (runtime) await runtime.dispose()
    if (!res.destroyed && !res.writableEnded) res.end()
  }
}

interface ResidentRunRequest {
  prompt: string
  permission: PermissionMode
  sessionId: string
  approvals: ApprovalBroker
  coding: boolean
  goalMode: boolean
  effective: EffectiveLlmConfig
  apiKey: string
}

async function evictResident(context: ServerContext, workspace: string, id: string): Promise<void> {
  const key = runKey(workspace, id)
  const entry = context.residentAgents?.get(key)
  if (!entry) return
  context.residentAgents?.delete(key)
  await entry.dispose()
}

/** A minimal runtime for a resident agent: tools + builtins (+coding) + agents. */
async function createResidentRuntime(
  workspace: string,
  req: ResidentRunRequest,
): Promise<{ root: Context; dispose: () => Promise<void> }> {
  const root = new Context()
  const fibers: Array<{ dispose: () => Promise<void> }> = []
  fibers.push(await root.plugin(tools))
  fibers.push(await root.plugin(memoryLocal, { cwd: workspace }))
  fibers.push(await root.plugin(toolMemory))
  fibers.push(await root.plugin(builtinTools, {
    cwd: workspace,
    allowNetwork: true,
    allowShell: true,
    allowOutsideWorkspace: req.permission === 'bypass',
    allowPrivateNetwork: req.permission === 'bypass',
  }))
  // 搜索与溢出是两条能力缝：composition 层挑 Provider，模型可见的工具只认识
  // ctx.search，工具结果的上限只认识 ctx.spillStore。
  fibers.push(await root.plugin(searchRipgrep, { cwd: workspace }))
  fibers.push(await root.plugin(toolSearch, { cwd: workspace }))
  fibers.push(await root.plugin(spillLocal, { cwd: workspace }))
  fibers.push(await root.plugin(toolSpill))
  if (req.coding) {
    fibers.push(await root.plugin(createCodingAgentPlugin({
      cwd: workspace,
      mode: 'auto',
      registerAgent: false,
    })))
  }
  fibers.push(await root.plugin(agents))
  const toolService = root.get('tools') as ToolsService
  const registry = root.get('agents') as AgentRegistry
  toolService.register(webSearchTool(searchApiKey(req.effective, req.apiKey)))
  toolService.guard(permissionGuard(req.permission, runKey(workspace, req.sessionId), req.approvals, {
    workspace,
    agentMode: agentId => {
      const meta = registry.get(agentId)?.meta
      if (!meta?.subagentMode) return undefined
      return meta.subagentPermission ?? (meta.subagentAllowShell ? 'workspace-write' : 'read-only')
    },
  }))
  fibers.push(await root.plugin(goalTools))
  fibers.push(await root.plugin(subagentLocal, {
    cwd: workspace,
    llm: adapterFromConfig(req.effective, req.apiKey),
    allowShell: req.permission !== 'read-only',
    allowNetwork: true,
    permission: req.permission,
  }))
  fibers.push(await root.plugin(toolSubagent))
  return {
    root,
    dispose: async () => {
      for (const fiber of [...fibers].reverse()) await fiber.dispose()
    },
  }
}

async function ensureResidentAgent(
  context: ServerContext,
  workspace: string,
  id: string,
  req: ResidentRunRequest,
): Promise<ResidentAgentEntry> {
  const key = runKey(workspace, id)
  const signature = [
    req.effective.baseUrl,
    req.effective.model,
    req.apiKey,
    req.effective.reasoningEffort ?? '',
    req.effective.protocol ?? '',
    req.effective.temperature ?? '',
    req.permission,
    req.coding ? 'coding' : 'general',
    'auto',
  ].join('|')
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
      llm: adapterFromConfig(req.effective, req.apiKey),
      manualStreaming: true,
    }
    if (req.coding) options.agentType = 'coding'
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
    agent,
    registry: (runtime.root as unknown as { agents: AgentRegistry }).agents,
    tools: runtime.root.get('tools') as ToolsService,
    signature,
    dispose: async () => {
      await disposeAgent().catch(() => undefined)
      await runtime.dispose()
    },
  }
  context.residentAgents?.set(key, entry)
  return entry
}

function isAgentMetaMissing(error: unknown): boolean {
  return error instanceof Error && error.message.includes('no agent session meta found')
}

async function runResidentTurn(
  context: ServerContext,
  res: ServerResponse,
  workspace: string,
  id: string,
  req: ResidentRunRequest,
): Promise<void> {
  const key = runKey(workspace, id)
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
    controller.abort({ type: 'user' })
  })

  let editTracking: { session: SessionLog; startSeq: number; baseline: Awaited<ReturnType<typeof captureFileEditBaseline>> } | undefined
  let releaseWriteCapture: ReturnType<ToolsService['guard']> | undefined

  try {
    const entry = await ensureResidentAgent(context, workspace, id, req)
    const agent = entry.agent
    await agent.session.append('meta', { kind: 'permission/run', mode: req.permission })
    editTracking = {
      session: agent.session,
      startSeq: (await agent.session.read()).at(-1)?.seq ?? 0,
      baseline: await captureFileEditBaseline(workspace),
    }
    const editBaseline = editTracking.baseline
    releaseWriteCapture = entry.tools.guard(async request => {
      if (request.name === 'write_file') await captureWritePreimage(workspace, editBaseline, request.input)
      return undefined
    })
    // A coding session keeps its persona as the durable leading system message,
    // seeded once so every derived request begins with it.
    if (req.coding) {
      const history = await agent.session.deriveMessages()
      if (!history.some(message => message.role === 'system')) {
        await agent.session.append('system/message', { content: CODING_SYSTEM_PROMPT })
      }
    }
    let goal = req.goalMode ? await readGoal(agent.session) : undefined
    if (req.goalMode && !goal) goal = await createGoal(agent.session, req.prompt)
    await agent.followup({ text: req.prompt })
    while (true) {
      for await (const event of agent.runTurns(controller.signal)) {
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
    await autoTitle(workspace, id, req.prompt, agent.session)
    if (!res.destroyed && !res.writableEnded) writeSse(res, { type: 'done' })
  } catch (error) {
    if (!res.destroyed && !res.writableEnded) {
      writeSse(res, { type: 'error', message: errorMessage(error) })
    }
  } finally {
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
    if (!res.destroyed && !res.writableEnded) res.end()
  }
}

interface EnsurePlanForRunOptions {
  adapter: ReturnType<typeof openaiCompatAdapter>
  session: SessionLog
  messages: readonly ModelMessage[]
  signal?: AbortSignal
  emit: (event: Record<string, unknown>) => void
}

async function ensurePlanForRun(options: EnsurePlanForRunOptions): Promise<Plan> {
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

function planPayload(plan: Plan): PlanPayload {
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

async function handleCodingCommands(
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

async function handleCodingSlash(
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

async function handleCodingSlashCandidates(
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

async function withCodingAgent<T>(
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
    fiber = await root.plugin(createCodingAgentPlugin({
      cwd: workspace,
      skills: true,
      mcp: true,
      planTools: true,
      ...(summary.mode ? { mode: summary.mode } : {}),
      setMode: async (next) => {
        const activeLog = root.get('session') as SessionLog
        await activeLog.append('meta/patch', { fields: ['mode'], mode: next })
        await activeLog.flush()
      },
    }))
    const coding = root.get('coding') as CodingService
    const sessionLog = root.get('session') as SessionLog
    return await run(coding, sessionLog)
  } finally {
    await fiber?.dispose()
  }
}

async function handleStopRun(
  context: ServerContext,
  workspace: string,
  id: string,
): Promise<void> {
  const controller = context.activeRuns.get(runKey(workspace, id))
  if (!controller) throw new HttpError(409, 'session is not running')
  controller.abort({ type: 'user' })
}

async function autoTitle(
  workspace: string, id: string, prompt: string, activeLog?: SessionLog,
): Promise<void> {
  const summary = await readSessionSummary(workspace, id)
  if (summary.title === 'New session') {
    if (activeLog) {
      await activeLog.append('meta/patch', { fields: ['title'], title: prompt.slice(0, 40) })
      await activeLog.flush()
    } else {
      await setSessionTitle(workspace, id, prompt.slice(0, 40))
    }
  }
}

async function readSessionEvents(
  workspace: string,
  id: string,
): Promise<{ events: unknown[]; surface: unknown[] }> {
  const runtime = await createAgentRuntime({
    cwd: workspace,
    sessionFile: sessionFilePath(workspace, id),
    llm: openaiCompatAdapter(),
  })
  try {
    const session = runtime.root.get('session') as SessionLog
    // Two views of the same log:
    //  - `events` is the human transcript (append history, compaction markers
    //    at their place) — compaction never hides history from the reader;
    //  - `surface` is the model view (shadowed messages removed).
    const events = await session.read()
    const surface = await session.surfaceEvents()
    return {
      events: JSON.parse(JSON.stringify(transcriptEvents(events))) as unknown[],
      surface: JSON.parse(JSON.stringify(surface)) as unknown[],
    }
  } finally {
    await runtime.dispose()
  }
}

function adapterFromConfig(
  effective: EffectiveLlmConfig,
  apiKey: string,
): ReturnType<typeof openaiCompatAdapter> {
  const options: {
    apiKey: string
    baseUrl: string
    model: string
    protocol?: 'anthropic' | 'openai'
    apiKeyHeader?: 'x-api-key' | 'api-key'
    temperature?: number
    reasoningEffort?: 'low' | 'medium' | 'high'
  } = {
    apiKey,
    baseUrl: effective.baseUrl,
    model: effective.model,
  }
  if (effective.protocol) options.protocol = effective.protocol
  if (effective.apiKeyHeader) options.apiKeyHeader = effective.apiKeyHeader
  if (effective.temperature !== undefined) options.temperature = effective.temperature
  if (effective.reasoningEffort) options.reasoningEffort = effective.reasoningEffort
  return createLlmAdapter(options)
}

async function appendSlashMeta(
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

function searchApiKey(effective: EffectiveLlmConfig, modelApiKey: string): string | undefined {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  try {
    const host = new URL(effective.baseUrl).hostname.toLowerCase()
    if (host === 'deepseek.com' || host.endsWith('.deepseek.com')) return modelApiKey
  } catch {
    // A non-URL model route cannot provide a DeepSeek search credential.
  }
  return undefined
}

function configSnapshot(config: SystemConfig, path = systemConfigPath()): Record<string, unknown> {
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
    },
    config: {
      apiKeySet: Boolean(config.apiKey),
      path,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      ...(config.model ? { model: config.model } : {}),
      ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
      ...(config.protocol ? { protocol: config.protocol } : {}),
      ...(config.temperature !== undefined
        ? { temperature: config.temperature }
        : {}),
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

function workspaceParam(url: URL): string | undefined {
  const value = url.searchParams.get('workspace')
  return value === null || !value.trim() ? undefined : value
}

function canonicalWorkspace(workspace: string): string {
  const resolved = resolve(workspace)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function runKey(workspace: string, id: string): string {
  return `${canonicalWorkspace(workspace)}\0${id}`
}

function isActive(
  active: Map<string, AbortController>,
  workspace: string,
  id: string,
): boolean {
  return active.has(runKey(workspace, id))
}

function sessionFilePath(workspace: string, id: string): string {
  return join(resolve(workspace), '.tnega', 'sessions', `${id}.jsonl`)
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new HttpError(400, 'request body is not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

async function handleStatic(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  webRoot: string,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendError(res, 405, 'method not allowed')
    return
  }
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const filePath = resolve(webRoot, relative)
  if (!filePath.startsWith(`${resolve(webRoot)}${sep}`) && filePath !== resolve(webRoot)) {
    sendError(res, 403, 'forbidden')
    return
  }
  let target = filePath
  try {
    const info = await stat(target)
    if (info.isDirectory()) target = join(target, 'index.html')
  } catch {
    target = join(webRoot, 'index.html')
  }
  try {
    const info = await stat(target)
    if (!info.isFile()) {
      sendError(res, 404, 'not found')
      return
    }
    const body = await readFile(target)
    res.writeHead(200, {
      'content-type': contentType(target),
      'content-length': body.byteLength,
      'cache-control': target.endsWith('index.html')
        ? 'no-cache'
        : 'public, max-age=3600',
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      sendError(res, 404, 'not found')
    } else {
      throw error
    }
  }
}

function contentType(file: string): string {
  switch (extname(file).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8'
    case '.js':
      return 'text/javascript; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.svg':
      return 'image/svg+xml'
    case '.png':
      return 'image/png'
    case '.ico':
      return 'image/x-icon'
    case '.woff2':
      return 'font/woff2'
    case '.map':
      return 'application/json; charset=utf-8'
    default:
      return 'application/octet-stream'
  }
}

function writeSse(res: ServerResponse, data: unknown): void {
  const value = JSON.stringify(data)
  const type = typeof data === 'object' && data !== null
    ? (data as { type?: unknown }).type
    : undefined
  const lines = [
    ...(typeof type === 'string' ? [`event: ${type}`] : []),
    `data: ${value}`,
    '',
    '',
  ]
  res.write(lines.join('\n'))
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.destroyed) return
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(data),
  })
  res.end(data)
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message })
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function defaultWebRoot(): string {
  const candidates = [
    // Bundled package layout: dist/bin.js serves dist/web.
    new URL('../dist/web/', import.meta.url),
    // Source checkout layout: packages/cli/src/server.ts serves <repo>/dist/web.
    new URL('../../../dist/web/', import.meta.url),
  ]
  for (const candidate of candidates) {
    const path = fileURLToPath(candidate)
    if (existsSync(path)) return path
  }
  return fileURLToPath(candidates[1]!)
}

class HttpError extends Error {
  override name = 'HttpError'

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}
