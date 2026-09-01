import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentStreamEvent } from '@tnega/agent'
import { Context } from '@tnega/core'
import {
  CODING_SYSTEM_PROMPT,
  createCodingAgentPlugin,
  createSlashRegistry,
  generatePlan,
  planToContext,
  type CodingService,
  type Plan,
  type PlanItem,
  type SlashCommandResult,
} from '@tnega/coding-agent'
import { createLlmAdapter, openaiCompatAdapter } from '@tnega/llm'
import {
  session,
  type ModelMessage,
  type PlanPayload,
  type SessionLog,
} from '@tnega/session'
import { tools } from '@tnega/tools'
import {
  createAgentRuntime,
  resolveLlmEnv,
  type AgentRuntime,
} from './commands.js'
import {
  effectiveApiKey,
  effectiveLlmConfig,
  readSystemConfig,
  updateSystemConfig,
  type EffectiveLlmConfig,
  type SystemConfig,
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
  readSessionSummary,
  type SessionSummary,
  setSessionTitle,
  truncateSessionAt,
} from './store.js'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 3080
const MAX_BODY_BYTES = 1024 * 1024
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
}

export interface WebServer {
  url: string
  port: number
  close: () => Promise<void>
}

export async function startWebServer(
  options: WebServerOptions = {},
): Promise<WebServer> {
  const host = options.host ?? DEFAULT_HOST
  const port = options.port ?? DEFAULT_PORT
  const webRoot = options.webRoot ?? defaultWebRoot()
  const configFile = options.configFile
  const activeRuns = new Map<string, AbortController>()
  let actualPort = port
  const context: ServerContext = {
    webRoot,
    activeRuns,
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
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error) rejectClose(error)
        else resolveClose()
      })
    }),
  }
}

interface ServerContext {
  webRoot: string
  configFile?: string
  activeRuns: Map<string, AbortController>
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

  if (url.pathname === '/api/config' && req.method === 'GET') {
    const config = await readSystemConfig(context.configFile)
    sendJson(res, 200, configSnapshot(config))
    return
  }

  if (url.pathname === '/api/config' && req.method === 'PUT') {
    const body = await readJsonBody(req)
    const patch: SystemConfig = {}
    if (typeof body.apiKey === 'string') patch.apiKey = body.apiKey
    if (typeof body.baseUrl === 'string') patch.baseUrl = body.baseUrl
    if (typeof body.model === 'string') patch.model = body.model
    if (typeof body.temperature === 'number' && Number.isFinite(body.temperature)) {
      patch.temperature = body.temperature
    }
    const config = await updateSystemConfig(patch, context.configFile)
    sendJson(res, 200, configSnapshot(config))
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
    const mode = body.mode === 'auto' || body.mode === 'plan' || body.mode === 'execute'
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

  const codingMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/coding\/(commands|slash)$/)
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
      await handleCodingSlash(req, res, workspace, id)
      return
    }
    sendError(res, 405, 'method not allowed')
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
      const events = await readSessionEvents(workspace, id)
      const contextUsage = await estimateContextUsage(workspace, id)
      sendJson(res, 200, {
        summary,
        events,
        context: contextUsage,
        running: isActive(context.activeRuns, workspace, id),
      })
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
      if (body.mode === 'auto' || body.mode === 'plan' || body.mode === 'execute') {
        patch.mode = body.mode
      }
      if (!Object.keys(patch).length) {
        sendError(res, 400, 'title, agentType or mode is required')
        return
      }
      const summary = await patchSessionMeta(workspace, id, patch)
      sendJson(res, 200, { summary })
      return
    }
    if (action === undefined && req.method === 'DELETE') {
      if (isActive(context.activeRuns, workspace, id)) {
        sendError(res, 409, 'session is running')
        return
      }
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
  const config = await readSystemConfig(context.configFile)
  const effective = effectiveLlmConfig(config)
  const apiKey = effectiveApiKey(config)
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
    maxTokens: 4096,
    timeoutMs: 180_000,
    ...(effective.temperature !== undefined
      ? { temperature: effective.temperature }
      : {}),
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
  return compactSession(
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
  const allowNetwork = body.allowNetwork === true
  const allowShell = body.allowShell === true
  const summary = await readSessionSummary(workspace, id)
  const coding = summary.agentType === 'coding'
  const mode = summary.mode ?? 'auto'

  const config = await readSystemConfig(context.configFile)
  const effective = effectiveLlmConfig(config)
  if (!effective.apiKeySet) {
    sendError(res, 400, 'API key is not configured')
    return
  }
  const apiKey = effectiveApiKey(config)
  if (!apiKey) {
    sendError(res, 400, 'API key is not configured')
    return
  }

  const controller = new AbortController()
  const adapter = adapterFromConfig(effective, apiKey)
  let runtime: AgentRuntime | undefined
  try {
    runtime = await createAgentRuntime({
      cwd: workspace,
      sessionFile: sessionFilePath(workspace, id),
      llm: adapter,
      allowNetwork,
      allowShell,
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

  try {
    const sessionLog = runtime.root.get('session') as SessionLog
    const history = await sessionLog.deriveMessages()
    const emitSse = (event: Record<string, unknown>): void => {
      if (!res.destroyed && !res.writableEnded) writeSse(res, event)
    }
    let plan: Plan | undefined
    if (coding && (mode === 'plan' || mode === 'execute')) {
      plan = await ensurePlanForRun({
        adapter,
        session: sessionLog,
        mode,
        messages: [...history, { role: 'user' as const, content: prompt }],
        signal: controller.signal,
        emit: emitSse,
      })
    }
    const messages: ModelMessage[] = [
      ...(coding ? [{ role: 'system' as const, content: CODING_SYSTEM_PROMPT }] : []),
      ...(plan ? [{ role: 'system' as const, content: planToContext(plan) }] : []),
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
      if (plan) await trackPlanTool(next.value, plan, sessionLog, emitSse)
    }
    await autoTitle(workspace, id, prompt)
    if (!res.destroyed && !res.writableEnded) {
      writeSse(res, { type: 'done' })
      res.end()
    }
  } catch (error) {
    if (!res.destroyed && !res.writableEnded) {
      writeSse(res, { type: 'error', message: errorMessage(error) })
      res.end()
    }
  } finally {
    context.activeRuns.delete(key)
    await runtime.dispose()
  }
}

interface EnsurePlanForRunOptions {
  adapter: ReturnType<typeof openaiCompatAdapter>
  session: SessionLog
  mode: 'plan' | 'execute'
  messages: readonly ModelMessage[]
  signal?: AbortSignal
  emit: (event: Record<string, unknown>) => void
}

async function ensurePlanForRun(options: EnsurePlanForRunOptions): Promise<Plan> {
  if (options.mode === 'execute') {
    const events = await options.session.read()
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type !== 'plan') continue
      const plan = planFromPayload(event.payload)
      if (!plan) continue
      for (const item of plan.items) item.status = 'pending'
      plan.status = 'pending'
      await options.session.append('plan', planPayload(plan))
      options.emit({ type: 'plan/start' })
      options.emit({ type: 'plan/items', plan })
      options.emit({ type: 'plan/done', plan })
      return plan
    }
  }

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

async function trackPlanTool(
  event: AgentStreamEvent,
  plan: Plan,
  session: SessionLog,
  emit: (event: Record<string, unknown>) => void,
): Promise<void> {
  if (event.type !== 'tool/end') return
  const args = event.call.arguments && typeof event.call.arguments === 'object'
    ? event.call.arguments as Record<string, unknown>
    : {}
  if (event.call.name === 'plan_execute_mark') {
    if (event.result && event.result.ok === false) return
    const id = typeof args.id === 'string' ? args.id : ''
    const status = typeof args.status === 'string' ? args.status : ''
    if (status !== 'pending' && status !== 'done' && status !== 'failed') return
    const item = plan.items.find(candidate => candidate.id === id)
    if (!item) return
    item.status = status
    plan.status = 'running'
    await session.append('plan', planPayload(plan))
    emit({ type: 'plan/item', item: { ...item } })
    return
  }
  if (event.call.name === 'plan_execute_result') {
    if (event.result && event.result.ok === false) return
    const status = typeof args.status === 'string' ? args.status : ''
    if (status !== 'done' && status !== 'failed') return
    plan.status = status
    await session.append('plan', planPayload(plan))
    emit({ type: 'plan/done', plan: { ...plan, items: plan.items.map(item => ({ ...item })) } })
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

function planFromPayload(payload: PlanPayload): Plan | undefined {
  if (!Array.isArray(payload.items) || !payload.items.length) return undefined
  const items: PlanItem[] = []
  for (let index = 0; index < payload.items.length; index += 1) {
    const entry = payload.items[index]!
    const title = typeof entry.title === 'string' && entry.title.trim()
      ? entry.title.trim()
      : undefined
    if (!title) return undefined
    const status = entry.status === 'pending' || entry.status === 'done' || entry.status === 'failed'
      ? entry.status
      : 'pending'
    const item: PlanItem = {
      id: typeof entry.id === 'string' && entry.id ? entry.id : `plan-${index + 1}`,
      title,
      status,
    }
    if (typeof entry.detail === 'string' && entry.detail) item.detail = entry.detail
    items.push(item)
  }
  const plan: Plan = {
    items,
    status: payload.status === 'pending' || payload.status === 'running'
      || payload.status === 'done' || payload.status === 'failed'
      ? payload.status
      : 'pending',
  }
  if (typeof payload.summary === 'string' && payload.summary) plan.summary = payload.summary
  return plan
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
        await patchSessionMeta(workspace, id, { mode: next })
      },
    }))
    const coding = root.get('coding') as CodingService
    const result: SlashCommandResult = await coding.runCommand(name, args)
    sendJson(res, 200, { result, mode: (await readSessionSummary(workspace, id)).mode ?? 'auto' })
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
  controller.abort()
}

async function autoTitle(workspace: string, id: string, prompt: string): Promise<void> {
  const summary = await readSessionSummary(workspace, id)
  if (summary.title === 'New session') {
    await setSessionTitle(workspace, id, prompt.slice(0, 40))
  }
}

async function readSessionEvents(
  workspace: string,
  id: string,
): Promise<unknown[]> {
  const runtime = await createAgentRuntime({
    cwd: workspace,
    sessionFile: sessionFilePath(workspace, id),
    llm: openaiCompatAdapter(),
  })
  try {
    const session = runtime.root.get('session') as SessionLog
    const events = await session.read()
    return JSON.parse(JSON.stringify(events)) as unknown[]
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
    temperature?: number
  } = {
    apiKey,
    baseUrl: effective.baseUrl,
    model: effective.model,
  }
  if (effective.temperature !== undefined) options.temperature = effective.temperature
  return createLlmAdapter(options)
}

function configSnapshot(config: SystemConfig): Record<string, unknown> {
  const effective = effectiveLlmConfig(config)
  const env = resolveLlmEnv(process.env)
  return {
    apiKeySet: effective.apiKeySet,
    effective: {
      baseUrl: effective.baseUrl,
      model: effective.model,
      ...(effective.temperature !== undefined
        ? { temperature: effective.temperature }
        : {}),
    },
    config: {
      apiKeySet: Boolean(config.apiKey),
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      ...(config.model ? { model: config.model } : {}),
      ...(config.temperature !== undefined
        ? { temperature: config.temperature }
        : {}),
    },
    env: {
      apiKeySet: Boolean(env.apiKey),
      ...(env.baseUrl ? { baseUrl: env.baseUrl } : {}),
      ...(env.model ? { model: env.model } : {}),
    },
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
