/**
 * The Timeline is the view model of a Session: an ordered list of entries a
 * human reads. Durable Agent Run boundaries separate responses even when no
 * new user message arrives. Older logs without boundaries continue grouping
 * agent activity between user messages.
 *
 * Two sources feed it: `fromEvents` rebuilds it from durable Session events,
 * and `applyStream` advances it with live Stream Events during a run. Once a
 * run ends the UI reloads, so durable events always have the final word.
 */
import type { CancelCause, ErrorInfo, SessionEvent, SlashResult, StreamEvent } from './types'

export interface ToolView {
  callId: string
  name: string
  args: unknown
  status: 'running' | 'ok' | 'error'
  output?: unknown
  error?: string
  durationMs?: number
  children?: ToolView[]
}

export interface SubagentView {
  callId?: string
  id?: string
  label: string
  task: string
  mode: 'spawn' | 'fork'
  status: 'starting' | 'running' | 'ready' | 'failed'
  replies: string[]
  error?: string
}

export interface EditedFile {
  path: string
  additions?: number
  deletions?: number
}

export type Block =
  | { kind: 'text'; id: string; text: string; streaming?: boolean }
  | { kind: 'tool'; id: string; tool: ToolView }
  | { kind: 'subagent'; id: string; agent: SubagentView }
  | { kind: 'files'; id: string; files: EditedFile[] }
  | { kind: 'notice'; id: string; tone: 'info' | 'warn' | 'error'; text: string; process?: boolean }

export type Entry =
  | { kind: 'user'; id: string; text: string; local?: boolean }
  | {
      kind: 'agent'
      id: string
      blocks: Block[]
      status: 'running' | 'done' | 'stopped' | 'error'
      /** Last durable assistant message id, usable as a fork point. */
      forkId?: string
      turn?: number
      /** Final answer from a successfully closed durable Agent Run. */
      summary?: { text: string; sourceMessageId: string }
    }
  | { kind: 'compaction'; id: string; summary: string; tokensBefore?: number }
  | { kind: 'slash'; id: string; command: string; args: string[]; result: SlashResult }

type AgentEntry = Extract<Entry, { kind: 'agent' }>

const AGENT_NAME = /^agent:([0-9a-f-]{36})$/i
const TERMINAL_REPLY = /^Subagent ([0-9a-f-]{36}) (completed|ended)\b(?: \([^)]*\))?:? ?/i
const STARTED = /^Started subagent ([0-9a-f-]{36})\b/i
const SPAWN_TOOL = 'spawn_subagent'

// ---------------------------------------------------------------------------
// Durable events → Timeline
// ---------------------------------------------------------------------------

export function fromEvents(events: readonly SessionEvent[]): Entry[] {
  const entries: Entry[] = []
  let turn: number | undefined
  const closed = new Set<number>()
  const completed = new Set<number>()
  const finalAnswers = new Map<number, { text: string; sourceMessageId: string }>()
  const byTurn = new Map<number, AgentEntry>()
  const agent = (id: string): AgentEntry => {
    const last = entries.at(-1)
    if (last?.kind === 'agent' && last.turn === turn) return last
    const created: AgentEntry = {
      kind: 'agent', id: `agent-${id}`, blocks: [], status: 'done',
      ...(turn !== undefined ? { turn } : {}),
    }
    entries.push(created)
    if (turn !== undefined) byTurn.set(turn, created)
    return created
  }

  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        turn = event.payload.turn
        break
      case 'user/message': {
        const { content, name } = event.payload
        if (!content) break
        const agentId = name?.match(AGENT_NAME)?.[1] ?? content.match(TERMINAL_REPLY)?.[1]
        if (agentId && addSubagentReply(entries, agentId, content)) break
        entries.push({ kind: 'user', id: event.id, text: content })
        break
      }
      case 'assistant/message': {
        const target = agent(event.id)
        const { content, toolCalls, interrupted } = event.payload
        if (content) target.blocks.push({ kind: 'text', id: event.id, text: content })
        target.forkId = event.id
        for (const call of toolCalls ?? []) addToolCall(target, call.id, call.name, call.arguments)
        if (interrupted) target.status = 'stopped'
        if (turn !== undefined && !closed.has(turn)) {
          finalAnswers.delete(turn)
          if (content.trim() && !interrupted && !toolCalls?.length) {
            finalAnswers.set(turn, { text: content, sourceMessageId: event.id })
          }
        }
        break
      }
      case 'tool/call':
        addToolCall(agent(event.id), event.payload.id, event.payload.name, event.payload.arguments)
        break
      case 'tool/result': {
        const { toolCallId, name, ok, output, error, durationMs } = event.payload
        const target = agent(event.id)
        if (!findToolBlock(target, toolCallId)) addToolCall(target, toolCallId, name, undefined)
        settleTool(target, toolCallId, ok, output, error, durationMs)
        break
      }
      case 'checkpoint':
        entries.push({
          kind: 'compaction',
          id: event.id,
          summary: event.payload.summary ?? '',
          ...(event.payload.tokensBefore !== undefined ? { tokensBefore: event.payload.tokensBefore } : {}),
        })
        break
      case 'meta': {
        if (event.payload.kind === 'ptc/dispatch-start' || event.payload.kind === 'ptc/dispatch') {
          addPtcDispatch(entries, event.payload)
          break
        }
        if (event.payload.kind === 'approval/review' && typeof event.payload.tool === 'string'
          && typeof event.payload.reason === 'string'
          && ['allow', 'deny', 'ask'].includes(String(event.payload.decision))) {
          agent(event.id).blocks.push({
            kind: 'notice', id: event.id, process: event.payload.decision === 'allow',
            tone: event.payload.decision === 'deny' ? 'error' : event.payload.decision === 'ask' ? 'warn' : 'info',
            text: approvalReviewNotice(event.payload),
          })
          break
        }
        const { kind, turn: summaryTurn, summary, sourceMessageId } = event.payload
        if (kind === 'run/summary' && typeof summaryTurn === 'number' && completed.has(summaryTurn)
          && typeof summary === 'string' && summary.trim() && typeof sourceMessageId === 'string') {
          const target = byTurn.get(summaryTurn)
          const source = finalAnswers.get(summaryTurn)
          if (target && source?.sourceMessageId === sourceMessageId) {
            target.summary = { text: summary, sourceMessageId }
          }
          break
        }
        const files = editedFiles(event.payload)
        if (files) {
          agent(event.id).blocks.push({ kind: 'files', id: event.id, files })
          break
        }
        const slash = slashMeta(event.payload)
        if (slash) entries.push({ kind: 'slash', id: event.id, ...slash })
        break
      }
      case 'llm/retry': {
        const { retry, delayMs, failure } = event.payload
        agent(event.id).blocks.push({
          kind: 'notice',
          id: event.id,
          tone: 'warn',
          text: `Retrying model request (attempt ${retry})${delayMs ? ` in ${formatDuration(delayMs)}` : ''}${failure ? ` — ${failure.message}` : ''}`,
        })
        break
      }
      case 'turn/end': {
        const { interrupted, cancelCause, error, finishReason, reason } = event.payload
        closed.add(event.payload.turn)
        const target = byTurn.get(event.payload.turn) ?? agent(event.id)
        const successful = !interrupted && !cancelCause && !error && target.status === 'done'
          && (reason ? reason.kind === 'completed' : finishReason === 'stop')
        if (successful) {
          completed.add(event.payload.turn)
          const summary = finalAnswers.get(event.payload.turn)
          if (summary) target.summary = summary
        }
        if (!interrupted && !cancelCause && !error) break
        target.status = error ? 'error' : 'stopped'
        target.blocks.push({ kind: 'notice', id: event.id, tone: error ? 'error' : 'info', text: endText(cancelCause, error) })
        break
      }
      default:
        break
    }
  }
  return entries
}

/** Keeps final answer, file summaries and failures outside the process disclosure. */
export function presentRun(entry: AgentEntry): { process: Block[]; visible: Block[] } {
  const summary = entry.summary
  if (!summary || entry.status !== 'done'
    || !entry.blocks.some(block => block.kind === 'text' && block.id === summary.sourceMessageId)) {
    return { process: [], visible: entry.blocks }
  }
  const process: Block[] = []
  const visible: Block[] = []
  for (const block of entry.blocks) {
    if (block.kind === 'text' && block.id === summary.sourceMessageId) {
      visible.push({ ...block, text: summary.text })
    } else if (block.kind === 'files' || (block.kind === 'notice' && !block.process)
      || (block.kind === 'tool' && block.tool.status !== 'ok')
      || (block.kind === 'subagent' && block.agent.status !== 'ready')) {
      visible.push(block)
    } else {
      process.push(block)
    }
  }
  return { process, visible }
}

function addToolCall(target: AgentEntry, callId: string, name: string, args: unknown): void {
  if (findToolBlock(target, callId) || findSubagentBlock(target, callId)) return
  if (name === SPAWN_TOOL) {
    target.blocks.push({ kind: 'subagent', id: `subagent-${callId}`, agent: subagentFromArgs(callId, args) })
    return
  }
  target.blocks.push({ kind: 'tool', id: `tool-${callId}`, tool: { callId, name, args, status: 'running' } })
}

function settleTool(
  target: AgentEntry,
  callId: string,
  ok: boolean,
  output: unknown,
  error: ErrorInfo | undefined,
  durationMs: number | undefined,
): void {
  const sub = findSubagentBlock(target, callId)
  if (sub) {
    const id = typeof output === 'string' ? output.match(STARTED)?.[1] : undefined
    if (id) sub.agent.id = id
    if (sub.agent.status === 'starting') sub.agent.status = ok ? 'running' : 'failed'
    if (error) sub.agent.error = error.message
    return
  }
  const block = findToolBlock(target, callId)
  if (!block) return
  block.tool = {
    ...block.tool,
    status: ok ? 'ok' : 'error',
    ...(output !== undefined ? { output } : {}),
    ...(error ? { error: error.message } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  }
}

function approvalReviewNotice(payload: Record<string, unknown>): string {
  const heading = payload.decision === 'allow' ? '自动审批已通过'
    : payload.decision === 'deny' ? '自动审批已拒绝' : '需要你确认'
  const reason = typeof payload.reason === 'string' ? payload.reason : ''
  let explanation = reason
  if (/conflict probability .* exceeds/i.test(reason)) {
    explanation = '操作可能与你的要求或约束冲突，需要你确认。'
  } else if (/risk confidence .* below/i.test(reason)) {
    const risk = payload.risk === 'low' ? '低风险' : payload.risk === 'medium' ? '中等风险' : payload.risk === 'high' ? '高风险' : undefined
    explanation = risk ? `初步判断为${risk}，但还不够确定，需要你确认。` : '风险判断还不够确定，需要你确认。'
  } else if (/cancelled|timed out/i.test(reason)) {
    explanation = /approval mode changed/i.test(reason) ? '自动审批已取消或模式已改变，需要你确认。' : '自动审批已取消或超时，需要你确认。'
  } else if (/unavailable|invalid decision/i.test(reason)) {
    explanation = '自动审批暂不可用，需要你确认。'
  } else if (/no human task is available/i.test(reason)) {
    explanation = '缺少你的任务指示，需要你确认。'
  } else if (reason === 'Jev confidently classified the action as high risk.') {
    explanation = '操作被判定为高风险，已拒绝执行。'
  } else if (reason === 'Action meets risk confidence and conflict thresholds.') {
    explanation = '操作符合当前要求与审批条件。'
  }
  return `${heading}：${payload.tool} — ${explanation}`
}

function addPtcDispatch(entries: Entry[], payload: Record<string, unknown>): void {
  const { parentCallId, callId, name, kind } = payload
  if (typeof parentCallId !== 'string' || typeof callId !== 'string' || typeof name !== 'string') return
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry?.kind !== 'agent') continue
    const parent = findToolBlock(entry, parentCallId)
    if (!parent) continue
    const children = parent.tool.children ??= []
    let child = children.find(tool => tool.callId === callId)
    if (!child) {
      child = { callId, name, args: payload.input, status: 'running' }
      children.push(child)
    }
    if (kind === 'ptc/dispatch') {
      child.status = payload.ok === true ? 'ok' : 'error'
      const result = payload.result
      if (result && typeof result === 'object') {
        if ('output' in result) child.output = result.output
        if ('durationMs' in result && typeof result.durationMs === 'number') child.durationMs = result.durationMs
        if ('error' in result && result.error && typeof result.error === 'object'
          && 'message' in result.error && typeof result.error.message === 'string') child.error = result.error.message
      } else if (result !== undefined) child.output = result
    }
    return
  }
}

function findToolBlock(target: AgentEntry, callId: string) {
  return target.blocks.find((b): b is Extract<Block, { kind: 'tool' }> => b.kind === 'tool' && b.tool.callId === callId)
}

function findSubagentBlock(target: AgentEntry, callId: string) {
  return target.blocks.find((b): b is Extract<Block, { kind: 'subagent' }> => b.kind === 'subagent' && b.agent.callId === callId)
}

function addSubagentReply(entries: Entry[], agentId: string, content: string): boolean {
  const terminal = content.match(TERMINAL_REPLY)
  const text = terminal ? content.slice(terminal[0].length) : content
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]
    if (entry?.kind !== 'agent') continue
    const block = entry.blocks.find((b): b is Extract<Block, { kind: 'subagent' }> => b.kind === 'subagent' && b.agent.id === agentId)
    if (!block) continue
    if (text && block.agent.replies.at(-1) !== text) block.agent.replies.push(text)
    if (terminal) block.agent.status = terminal[2] === 'completed' ? 'ready' : 'failed'
    return true
  }
  return false
}

export function subagentFromArgs(callId: string, args: unknown): SubagentView {
  const record = args && typeof args === 'object' ? args as Record<string, unknown> : {}
  const task = typeof record.task === 'string' ? record.task : ''
  const label = typeof record.label === 'string' && record.label ? record.label : task.slice(0, 64) || 'Subagent'
  return { callId, label, task, mode: record.mode === 'fork' ? 'fork' : 'spawn', status: 'starting', replies: [] }
}

function editedFiles(payload: Record<string, unknown>): EditedFile[] | undefined {
  if (payload.kind !== 'files/edited' || !Array.isArray(payload.files)) return undefined
  const files = payload.files.flatMap((value: unknown): EditedFile[] => {
    if (typeof value === 'string') return [{ path: value }]
    if (!value || typeof value !== 'object') return []
    const { path, additions, deletions } = value as Record<string, unknown>
    if (typeof path !== 'string') return []
    return [{
      path,
      ...(typeof additions === 'number' ? { additions } : {}),
      ...(typeof deletions === 'number' ? { deletions } : {}),
    }]
  })
  return files.length ? files : undefined
}

function slashMeta(payload: Record<string, unknown>): { command: string; args: string[]; result: SlashResult } | undefined {
  if (payload.kind !== 'slash' || typeof payload.command !== 'string') return undefined
  const result = payload.result as SlashResult | undefined
  if (!result || (result.kind !== 'text' && result.kind !== 'json')) return undefined
  const args = Array.isArray(payload.args) ? payload.args.filter((a): a is string => typeof a === 'string') : []
  return { command: payload.command, args, result }
}

function endText(cause: CancelCause | undefined, error: ErrorInfo | undefined): string {
  if (error) return error.message
  if (!cause) return 'Interrupted'
  switch (cause.type) {
    case 'user': return 'Stopped by you'
    case 'parent': return 'Stopped by parent agent'
    case 'disposed': return 'Agent was shut down'
    case 'abort': return cause.message ? `Aborted: ${cause.message}` : 'Aborted'
    case 'timeout': return `Timed out after ${formatDuration(cause.timeoutMs)}`
  }
}

// ---------------------------------------------------------------------------
// Live Stream Events → Timeline
// ---------------------------------------------------------------------------

/** Append the optimistic user message and an empty running agent turn. */
export function beginRun(entries: readonly Entry[], prompt: string, now = Date.now()): Entry[] {
  return [
    ...entries,
    { kind: 'user', id: `local-user-${now}`, text: prompt, local: true },
    { kind: 'agent', id: `local-agent-${now}`, blocks: [], status: 'running' },
  ]
}

/** Advance the running turn with one Stream Event. Returns the same array when nothing changed. */
export function applyStream(entries: readonly Entry[], event: StreamEvent): readonly Entry[] {
  const last = entries.at(-1)
  if (last?.kind !== 'agent') return entries
  const next = applyToAgent(last, event)
  return next === last ? entries : [...entries.slice(0, -1), next]
}

function applyToAgent(entry: AgentEntry, event: StreamEvent): AgentEntry {
  const blocks = entry.blocks
  switch (event.type) {
    case 'message_start':
      return { ...entry, blocks: [...blocks, { kind: 'text', id: `live-${event.id}`, text: '', streaming: true }] }
    case 'message_delta': {
      const index = findLastIndex(blocks, b => b.kind === 'text' && b.id === `live-${event.id}`)
      if (index < 0) {
        return { ...entry, blocks: [...blocks, { kind: 'text', id: `live-${event.id}`, text: event.delta, streaming: true }] }
      }
      const block = blocks[index] as Extract<Block, { kind: 'text' }>
      return { ...entry, blocks: replaceAt(blocks, index, { ...block, text: block.text + event.delta }) }
    }
    case 'message_stop': {
      const id = `live-${event.id}`
      return {
        ...entry,
        blocks: blocks.flatMap(b => {
          if (b.kind !== 'text' || b.id !== id) return [b]
          return b.text.trim() ? [{ ...b, streaming: false }] : []
        }),
      }
    }
    case 'tool/start': {
      const { id, name, arguments: args } = event.call
      if (blocks.some(b => (b.kind === 'tool' && b.tool.callId === id) || (b.kind === 'subagent' && b.agent.callId === id))) return entry
      const block: Block = name === SPAWN_TOOL
        ? { kind: 'subagent', id: `subagent-${id}`, agent: subagentFromArgs(id, args) }
        : { kind: 'tool', id: `tool-${id}`, tool: { callId: id, name, args, status: 'running' } }
      return { ...entry, blocks: [...blocks, block] }
    }
    case 'tool/end': {
      const { call, result } = event
      return {
        ...entry,
        blocks: blocks.map((b): Block => {
          if (b.kind === 'subagent' && b.agent.callId === call.id) {
            const id = typeof result.output === 'string' ? result.output.match(STARTED)?.[1] : undefined
            return {
              ...b,
              agent: {
                ...b.agent,
                ...(id ? { id } : {}),
                status: result.ok ? 'running' : 'failed',
                ...(result.error ? { error: result.error.message } : {}),
              },
            }
          }
          if (b.kind !== 'tool' || b.tool.callId !== call.id) return b
          return {
            ...b,
            tool: {
              ...b.tool,
              status: result.ok ? 'ok' : 'error',
              ...(result.output !== undefined ? { output: result.output } : {}),
              ...(result.error ? { error: result.error.message } : {}),
              ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
            },
          }
        }),
      }
    }
    case 'plan/error':
      return { ...entry, blocks: [...blocks, { kind: 'notice', id: `plan-error-${blocks.length}`, tone: 'error', text: `Planning failed: ${event.message}` }] }
    case 'error':
      return {
        ...entry,
        status: 'error',
        blocks: [...blocks, { kind: 'notice', id: `error-${blocks.length}`, tone: 'error', text: event.message }],
      }
    case 'done':
      return { ...entry, status: entry.status === 'running' ? 'done' : entry.status }
    default:
      return entry
  }
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) if (predicate(items[i]!)) return i
  return -1
}

function replaceAt<T>(items: readonly T[], index: number, value: T): T[] {
  const copy = items.slice()
  copy[index] = value
  return copy
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${Math.round(seconds % 60)}s`
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function stringify(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
