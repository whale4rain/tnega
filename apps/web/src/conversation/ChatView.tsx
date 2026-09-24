import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, IconButton } from '@radix-ui/themes'
import { ArrowUp, Square, ChevronDown, Code2, ListTodo } from 'lucide-react'
import { ConversationNav } from '../ConversationNav'
import { groupToolMessages } from '../toolGroups'
import { PlanPanel } from '../PlanPanel'
import {
  applyPlanStreamEvent,
  formatSlashMessage,
  slashPromptParts,
  type DisplayPlan,
} from '../planDisplay'
import { ComposerFrame } from '../workbench/ComposerFrame'
import { MessageBlock, ToolGroupBlock, ContextRing } from './Transcript'
import { ApiError, displayPath, prettyJson } from '../api'
import * as api from '../api'
import { UsageMetrics } from './UsageMetrics'
import { SubagentSidebar } from './SubagentSidebar'
import { subagentFromCall, subagentIdFromResult } from '../subagentDisplay'
import type {
  SessionSummary,
  SubagentEntry,
  GoalState,
  SessionDetail,
  ContextUsage,
  SessionMetrics,
  DisplayMessage,
  SlashCommand,
  SlashSuggestion,
  StreamEvent,
} from '../types'
type RunState = 'idle' | 'running' | 'cancelling'

interface ChatViewProps {
  model?: string
  onSettings: () => void
  workspace: string | null
  sessionId: string | null
  summary: SessionSummary | null
  context: ContextUsage | null
  metrics?: SessionMetrics | null
  sessionRunning: boolean
  messages: DisplayMessage[]
  plan?: DisplayPlan
  apiKeySet: boolean
  onNewSession: (options?: {
    agentType?: 'general' | 'coding'
    mode?: 'auto' | 'plan' | 'goal'
  }) => Promise<void>
  onRefresh: (id: string, refreshList?: boolean) => Promise<SessionDetail | undefined>
  onForkAt: (id: string, messageId: string) => Promise<void>
  onMessagesChange: (
    updater: (current: DisplayMessage[]) => DisplayMessage[],
  ) => void
  onPlanChange: (
    updater: (current: DisplayPlan | undefined) => DisplayPlan | undefined,
  ) => void
  onModeChange: (mode: 'auto' | 'plan' | 'goal') => Promise<void>
}

export function ChatView({
  model,
  onSettings,
  workspace,
  sessionId,
  summary,
  context,
  metrics,
  sessionRunning,
  messages,
  plan,
  apiKeySet,
  onNewSession,
  onRefresh,
  onForkAt,
  onMessagesChange,
  onPlanChange,
  onModeChange,
}: ChatViewProps) {
  const [prompt, setPrompt] = useState('')
  const [subagents, setSubagents] = useState<SubagentEntry[]>([])
  const [showSubagents, setShowSubagents] = useState(false)
  const [selectedSubagentId, setSelectedSubagentId] = useState<string | null>(null)
  const [goal, setGoal] = useState<GoalState | null>(null)
  const [permission, setPermission] = useState<'read-only' | 'workspace-write' | 'bypass'>('read-only')
  const [approvals, setApprovals] = useState<Array<{ id: string; tool: string; input: string }>>([])
  const [runState, setRunState] = useState<RunState>('idle')
  const [compacting, setCompacting] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [showJump, setShowJump] = useState(false)
  const [navIndex, setNavIndex] = useState(0)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([])
  const [slashError, setSlashError] = useState<string | null>(null)
  const [slashBusy, setSlashBusy] = useState(false)
  const [slashSubmenu, setSlashSubmenu] = useState<{
    command: SlashCommand
    candidates: SlashSuggestion[]
    busy: boolean
    error: string | null
  } | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const runStateRef = useRef<RunState>('idle')
  const planRef = useRef<DisplayPlan | undefined>(undefined)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const composerSurfaceRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!workspace || !sessionId) {
      setSubagents([])
      return
    }
    let cancelled = false
    let pending = false
    let previousStatuses: string | null = null
    const refresh = () => {
      if (pending) return
      pending = true
      void api.listSubagents(workspace, sessionId)
        .then(result => {
          if (!cancelled) {
            const statuses = result.subagents.map(child => `${child.id}:${child.status}`).join('|')
            if (previousStatuses !== null && statuses !== previousStatuses) {
              void onRefresh(sessionId, false).catch(() => undefined)
            }
            previousStatuses = statuses
            setSubagents(current =>
              JSON.stringify(current) === JSON.stringify(result.subagents) ? current : result.subagents)
          }
        })
        .catch(() => { if (!cancelled) setSubagents([]) })
        .finally(() => { pending = false })
    }
    refresh()
    const timer = window.setInterval(refresh, 2_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [workspace, sessionId, onRefresh])
  useEffect(() => {
    setShowSubagents(false)
    setSelectedSubagentId(null)
  }, [workspace, sessionId])
  useEffect(() => {
    if (!workspace || !sessionId || summary?.mode !== 'goal') {
      setGoal(null)
      return
    }
    let cancelled = false
    let pending = false
    const refresh = () => {
      if (pending) return
      pending = true
      void api.getGoal(workspace, sessionId)
        .then(result => {
          if (!cancelled) setGoal(current =>
            JSON.stringify(current) === JSON.stringify(result.goal) ? current : result.goal)
        })
        .catch(() => { if (!cancelled) setGoal(null) })
        .finally(() => { pending = false })
    }
    refresh()
    const timer = window.setInterval(refresh, 2_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [workspace, sessionId, summary?.mode])
  const userRefs = useRef(new Map<string, HTMLDivElement>())
  const stickToBottomRef = useRef(true)
  const streamDeltaRef = useRef(new Map<string, string>())
  const streamFlushFrameRef = useRef<number | null>(null)
  const streamFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const userIndexes = useMemo(() => {
    const indexes: number[] = []
    messages.forEach((message, index) => {
      if (message.role === 'user') indexes.push(index)
    })
    return indexes
  }, [messages])

  const renderItems = useMemo(() => groupToolMessages(messages), [messages])

  const scrollToBottom = useCallback(() => {
    const node = scrollRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [])
  const openSubagent = useCallback((id: string) => {
    setSelectedSubagentId(id)
    setShowSubagents(true)
  }, [])

  useEffect(() => {
    const surface = composerSurfaceRef.current
    if (!surface || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (stickToBottomRef.current) scrollToBottom()
    })
    observer.observe(surface)
    return () => observer.disconnect()
  }, [sessionId, summary?.id, scrollToBottom])

  useEffect(() => {
    setNavIndex(0)
    userRefs.current.clear()
    stickToBottomRef.current = true
    setEditingId(null)
    setEditDraft('')
    scrollToBottom()
  }, [scrollToBottom, sessionId, workspace])

  useEffect(() => {
    runStateRef.current = runState
  }, [runState])

  useEffect(() => {
    planRef.current = plan
  }, [plan])

  const isCoding = summary?.agentType === 'coding'
  const mode = summary?.mode ?? 'auto'

  useEffect(() => {
    setSlashSubmenu(null)
    if (!workspace || !sessionId || !isCoding) {
      setSlashCommands([])
      setSlashError(null)
      return
    }
    let cancelled = false
    setSlashBusy(true)
    api
      .codingCommands(workspace, sessionId)
      .then((result) => {
        if (!cancelled) setSlashCommands(result.commands)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setSlashError(messageOf(reason))
      })
      .finally(() => {
        if (!cancelled) setSlashBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [isCoding, sessionId, workspace])

  useEffect(() => {
    if (sessionRunning && runStateRef.current === 'idle') setRunState('running')
  }, [sessionRunning])

  useEffect(() => {
    if ((!sessionRunning && !subagents.some(child => child.status === 'running'))
      || !workspace || !sessionId) return
    let cancelled = false
    let pending = false
    const poll = async (): Promise<void> => {
      if (pending) return
      pending = true
      try {
        const detail = await onRefresh(sessionId, false)
        if (cancelled) return
        if (detail?.running && runStateRef.current === 'idle') {
          setRunState('running')
        } else if (!detail?.running) {
          setRunState('idle')
        }
      } catch (reason) {
        if (!cancelled) setRunError(messageOf(reason))
      } finally {
        pending = false
      }
    }
    const timer = setInterval(() => {
      void poll()
    }, 2_500)
    void poll()
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [onRefresh, sessionId, sessionRunning, subagents, workspace])

  useEffect(() => {
    if (navIndex >= userIndexes.length) {
      setNavIndex(userIndexes.length === 0 ? 0 : userIndexes.length - 1)
    }
  }, [navIndex, userIndexes.length])

  useEffect(() => {
    if (!stickToBottomRef.current) return
    scrollToBottom()
    if (userIndexes.length) setNavIndex(userIndexes.length - 1)
  }, [messages, scrollToBottom, userIndexes.length])

  function handleMessagesScroll() {
    const node = scrollRef.current
    if (!node) return
    const nearBottom =
      node.scrollHeight - node.scrollTop - node.clientHeight < 80
    stickToBottomRef.current = nearBottom
    setShowJump(!nearBottom && node.scrollHeight > node.clientHeight + 1)
    updateActiveUserFromScroll()
  }

  function updateActiveUserFromScroll() {
    const node = scrollRef.current
    if (!node) return
    const threshold = node.scrollTop + node.clientHeight * 0.5
    let activeIndex = 0
    let bestDistance = Infinity
    for (let index = 0; index < userIndexes.length; index += 1) {
      const message = messages[userIndexes[index]]
      const element = message ? userRefs.current.get(message.id) : undefined
      if (!element) continue
      const top =
        element.getBoundingClientRect().top -
        node.getBoundingClientRect().top +
        node.scrollTop
      const distance = Math.abs(top - threshold)
      if (distance < bestDistance) {
        bestDistance = distance
        activeIndex = index
      }
    }
    if (activeIndex !== navIndex) setNavIndex(activeIndex)
  }

  function jumpToBottom() {
    stickToBottomRef.current = true
    setShowJump(false)
    scrollToBottom()
  }

  function scrollToUserMessage(targetIndex: number) {
    const messageIndex = userIndexes[targetIndex]
    if (messageIndex === undefined) return
    const target = messages[messageIndex]
    const node = target ? userRefs.current.get(target.id) : undefined
    if (!node) return
    stickToBottomRef.current = false
    setShowJump(true)
    node.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  const running = runState === 'running' || runState === 'cancelling'
  const activeSubagents = subagents.filter(child => child.status === 'running').length

  async function answerPendingApproval(allow: boolean): Promise<void> {
    const approval = approvals[0]
    if (!approval || !workspace || !sessionId) return
    try {
      await api.answerApproval(workspace, sessionId, approval.id, allow)
      setApprovals(current => current.filter(item => item.id !== approval.id))
    } catch (reason) {
      setRunError(messageOf(reason))
    }
  }

  async function runPrompt(text: string) {
    const sent = text.trim()
    if (!workspace || !sessionId || !sent || running || compacting) return
    const slash = slashPromptParts(sent)
    if (slash && isCoding) {
      await runSlash(slash.name, slash.args)
      return
    }
    if (!apiKeySet) {
      setRunError('API key is not configured')
      return
    }
    const controller = new AbortController()
    abortRef.current = controller
    setRunError(null)
    setRunState('running')
    stickToBottomRef.current = true
    setShowJump(false)
    setNavIndex(userIndexes.length)
    onMessagesChange((current) => [
      ...current,
      {
        id: `live-user-${Date.now()}`,
        role: 'user',
        content: sent,
      },
    ])
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await api.streamRun(
            workspace,
            sessionId,
            {
              prompt: sent,
              permission,
            },
            (event) => handleStreamEvent(event),
            controller.signal,
          )
          flushStreamDeltas()
          break
        } catch (reason) {
          if (
            reason instanceof ApiError &&
            reason.status === 409 &&
            attempt < 10 &&
            !controller.signal.aborted
          ) {
            await delay(400)
            continue
          }
          throw reason
        }
      }
      await onRefresh(sessionId)
    } catch (reason) {
      if (controller.signal.aborted) {
        await delay(300)
        await onRefresh(sessionId)
      } else {
        setRunError(messageOf(reason))
      }
    } finally {
      setApprovals([])
      abortRef.current = null
      setRunState('idle')
    }
  }

  async function runSlash(name: string, args: string[]) {
    if (!workspace || !sessionId) return
    const startGoal = name === '/goal' && args.length > 0
      && !['pause', 'resume', 'clear'].includes(args[0]!.toLowerCase())
      ? args.join(' ') : undefined
    let accepted = false
    setRunError(null)
    setSlashBusy(true)
    try {
      const { result } = await api.codingSlash(workspace, sessionId, name, args)
      const text = formatSlashMessage(name, args, result)
      onMessagesChange((current) => [
        ...current,
        {
          id: `slash-${name}-${Date.now()}`,
          role: 'system',
          content: text,
          slash: { kind: 'slash', command: name, args, result },
        },
      ])
      await onRefresh(sessionId)
      accepted = true
    } catch (reason) {
      setRunError(messageOf(reason))
    } finally {
      setSlashBusy(false)
    }
    if (accepted && startGoal) void runPrompt(startGoal)
  }

  function startRun() {
    if (!prompt.trim() || running || compacting || !apiKeySet || slashBusy)
      return
    const sent = prompt.trim()
    setPrompt('')
    void runPrompt(sent)
  }

  function selectSlashCommand(command: SlashCommand) {
    setPrompt(command.name + ' ')
    setSlashError(null)
    if (command.name === '/skills' || command.name === '/mcp') {
      void openSlashSubmenu(command)
    } else {
      setSlashSubmenu(null)
    }
    composerRef.current?.focus()
  }

  async function openSlashSubmenu(command: SlashCommand) {
    if (!workspace || !sessionId) return
    setSlashSubmenu({ command, candidates: [], busy: true, error: null })
    try {
      const { candidates } = await api.codingSlashCandidates(
        workspace,
        sessionId,
        command.name,
      )
      setSlashSubmenu((current) =>
        current?.command.name === command.name
          ? { ...current, candidates, busy: false }
          : current,
      )
    } catch (reason) {
      setSlashSubmenu((current) =>
        current?.command.name === command.name
          ? { ...current, busy: false, error: messageOf(reason) }
          : current,
      )
    }
  }

  function closeSlashSubmenu() {
    if (slashSubmenu) setPrompt(slashSubmenu.command.name)
    setSlashSubmenu(null)
  }

  function chooseSlashSuggestion(suggestion: SlashSuggestion) {
    setSlashSubmenu(null)
    setPrompt('')
    void runSlash(suggestion.command, suggestion.args)
  }

  async function cancelRun() {
    if (runState !== 'running') return
    if (!workspace || !sessionId) return
    setRunState('cancelling')
    try {
      await api.stopRun(workspace, sessionId)
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409) {
        abortRef.current?.abort({ type: 'user' })
        return
      }
      setRunError(messageOf(reason))
      setRunState('running')
      return
    }
    abortRef.current?.abort({ type: 'user' })
  }

  const slashMenuVisible =
    isCoding &&
    !slashBusy &&
    (slashSubmenu !== null || (prompt.startsWith('/') && !prompt.includes(' ')))

  function beginEdit(message: DisplayMessage) {
    setEditingId(message.id)
    setEditDraft(message.content)
    stickToBottomRef.current = false
  }

  function cancelEdit() {
    setEditingId(null)
    setEditDraft('')
  }

  async function submitEdit() {
    const content = editDraft.trim()
    const id = editingId
    if (!workspace || !sessionId || !id || !content) return
    if (!apiKeySet) {
      setRunError('API key is not configured')
      return
    }
    setEditingId(null)
    setEditDraft('')
    try {
      await api.truncateSession(workspace, sessionId, id)
      await onRefresh(sessionId)
    } catch (reason) {
      setRunError(messageOf(reason))
      return
    }
    await runPrompt(content)
  }

  function forkHere(messageId: string) {
    if (!sessionId) return
    void onForkAt(sessionId, messageId)
  }

  async function handleCompact() {
    if (!workspace || !sessionId || running || compacting) return
    setRunError(null)
    setCompacting(true)
    try {
      await api.compactSession(workspace, sessionId)
      await onRefresh(sessionId)
    } catch (reason) {
      setRunError(messageOf(reason))
    } finally {
      setCompacting(false)
    }
  }

  useEffect(() => {
    return () => {
      if (streamFlushFrameRef.current !== null) {
        cancelAnimationFrame(streamFlushFrameRef.current)
      }
      if (streamFlushTimerRef.current !== null) {
        clearTimeout(streamFlushTimerRef.current)
      }
    }
  }, [])

  function flushStreamDeltas() {
    if (streamFlushFrameRef.current !== null) {
      cancelAnimationFrame(streamFlushFrameRef.current)
      streamFlushFrameRef.current = null
    }
    if (streamFlushTimerRef.current !== null) {
      clearTimeout(streamFlushTimerRef.current)
      streamFlushTimerRef.current = null
    }
    const deltas = streamDeltaRef.current
    if (deltas.size === 0) return
    streamDeltaRef.current = new Map()
    onMessagesChange((current) => applyStreamDeltas(current, deltas))
  }

  function scheduleStreamFlush() {
    if (
      streamFlushFrameRef.current !== null ||
      streamFlushTimerRef.current !== null
    ) {
      return
    }
    if (typeof requestAnimationFrame === 'function') {
      streamFlushFrameRef.current = requestAnimationFrame(() => {
        streamFlushFrameRef.current = null
        flushStreamDeltas()
      })
      return
    }
    streamFlushTimerRef.current = setTimeout(() => {
      streamFlushTimerRef.current = null
      flushStreamDeltas()
    }, 0)
  }

  function queueStreamDelta(id: string, delta: string) {
    const queued = streamDeltaRef.current.get(id) ?? ''
    streamDeltaRef.current.set(id, queued + delta)
    scheduleStreamFlush()
  }

  function applyStreamDeltas(
    current: DisplayMessage[],
    deltas: ReadonlyMap<string, string>,
  ): DisplayMessage[] {
    let next = current
    for (const [id, delta] of deltas) {
      const liveId = `live-${id}`
      const index = next.findIndex((message) => message.id === liveId)
      if (index !== -1) {
        const entry = next[index]!
        next = next.map((message, messageIndex) =>
          messageIndex === index
            ? { ...entry, content: entry.content + delta, pending: true }
            : message,
        )
        continue
      }
      const fallback = findPendingAssistant(next) ?? lastAssistant(next)
      if (fallback) {
        next = next.map((message) =>
          message === fallback
            ? { ...message, content: message.content + delta, pending: true }
            : message,
        )
        continue
      }
      next = [
        ...next,
        {
          id: liveId,
          role: 'assistant',
          content: delta,
          pending: true,
        },
      ]
    }
    return next
  }

  function handleStreamEvent(event: StreamEvent) {
    if (event.type === 'approval/request') {
      setApprovals(current => [...current, { id: event.id, tool: event.tool, input: event.input }])
      return
    }
    if (event.type === 'message_delta') {
      queueStreamDelta(event.id, event.delta)
      return
    }
    if (
      event.type === 'plan/start' ||
      event.type === 'plan/items' ||
      event.type === 'plan/item' ||
      event.type === 'plan/done' ||
      event.type === 'plan/error'
    ) {
      const current = planRef.current
      const next = applyPlanStreamEvent(current, event)
      if (next !== current) onPlanChange(() => next)
      if (event.type === 'plan/error') {
        onMessagesChange((currentMessages) => [
          ...currentMessages,
          {
            id: `live-plan-error-${Date.now()}`,
            role: 'system',
            content: `plan failed: ${event.message}`,
          },
        ])
      }
      return
    }

    flushStreamDeltas()

    onMessagesChange((current) => {
      switch (event.type) {
        case 'message_start':
          return [
            ...current,
            {
              id: `live-${event.id}`,
              role: 'assistant',
              content: '',
              pending: true,
            },
          ]
        case 'message_stop': {
          const id = `live-${event.id}`
          const target =
            current.find((message) => message.id === id) ??
            findPendingAssistant(current)
          if (!target) break
          return current.map((message) =>
            message === target
              ? { ...message, pending: false, finishReason: event.finishReason }
              : message,
          )
        }
        case 'tool/start':
          if (event.call.name === 'spawn_subagent') {
            return [...current, {
              id: `live-subagent-${event.call.id}`,
              role: 'subagent',
              content: '',
              subagent: subagentFromCall(event.call.id, event.call.arguments),
            }]
          }
          return [
            ...current,
            {
              id: `live-tool-${event.call.id}`,
              role: 'tool',
              content: '',
              tool: {
                callId: event.call.id,
                name: event.call.name,
                argumentsText: prettyJson(event.call.arguments),
                status: 'pending',
              },
            },
          ]
        case 'tool/end': {
          if (event.call.name === 'spawn_subagent') {
            const agentId = subagentIdFromResult(event.result.output)
            return current.map(message => message.subagent?.callId === event.call.id
              ? {
                  ...message,
                  subagent: {
                    ...message.subagent,
                    ...(agentId ? { id: agentId } : {}),
                    status: event.result.ok ? 'running' as const : 'failed' as const,
                    ...(event.result.error?.message ? { error: event.result.error.message } : {}),
                  },
                }
              : message)
          }
          let targetIndex = -1
          for (let index = current.length - 1; index >= 0; index -= 1) {
            const entry = current[index]
            if (
              entry &&
              entry.role === 'tool' &&
              entry.tool?.callId === event.call.id &&
              entry.tool.status === 'pending'
            ) {
              targetIndex = index
              break
            }
          }
          if (targetIndex === -1) break
          const entry = current[targetIndex]!
          const tool = entry.tool!
          return current.map((message, messageIndex) =>
            messageIndex === targetIndex
              ? {
                  ...entry,
                  tool: {
                    ...tool,
                    status: 'done',
                    ok: event.result.ok,
                    outputText:
                      event.result.output === undefined
                        ? undefined
                        : prettyJson(event.result.output),
                    errorText: event.result.error?.message,
                  },
                }
              : message,
          )
        }
        case 'run/end': {
          const failed =
            event.run.finishReason === 'cancelled' ||
            event.run.finishReason === 'error'
          return current.map((message) =>
            message.role === 'assistant' && message.pending
              ? {
                  ...message,
                  pending: false,
                  ...(failed && message.content ? { interrupted: true } : {}),
                  ...(message.finishReason
                    ? {}
                    : { finishReason: event.run.finishReason }),
                }
              : message,
          )
        }
        case 'error':
          return [
            ...current.map((message) =>
              message.role === 'assistant' && message.pending
                ? {
                    ...message,
                    pending: false,
                    ...(message.content ? { interrupted: true } : {}),
                    ...(message.finishReason ? {} : { finishReason: 'error' }),
                  }
                : message,
            ),
            {
              id: `live-error-${Date.now()}`,
              role: 'system',
              content: event.message,
            },
          ]
        default:
          return current
      }
      return current
    })
  }

  if (!workspace) {
    return (
      <div className="empty-state">
        <Code2 size={36} strokeWidth={1.2} />
        <h1>Make room for your next idea.</h1>
        <p>Add a workspace from the sidebar to start coding with Tnega.</p>
      </div>
    )
  }

  if (!sessionId) {
    return (
      <div className="empty-state">
        <Code2 size={36} strokeWidth={1.2} />
        <h1>What are we building?</h1>
        <p>Explore a codebase, work through a bug, or build something new.</p>
        <Button onClick={() => void onNewSession({ agentType: 'coding' })}>
          Start coding
        </Button>
      </div>
    )
  }

  return (
    <div className="chat">
      {approvals[0] && (
        <div className="approval-backdrop" role="dialog" aria-modal="true" aria-label="Tool approval">
          <div className="approval-card">
            <h3>Approve tool call?</h3>
            <p>{approvals[0].tool} requests access beyond {permission} permissions.</p>
            <pre>{approvals[0].input}</pre>
            <div className="approval-actions">
              <Button variant="soft" color="gray" onClick={() => void answerPendingApproval(false)}>Deny</Button>
              <Button onClick={() => void answerPendingApproval(true)}>Allow once</Button>
            </div>
          </div>
        </div>
      )}
      <div className="chat-content">
      <div className="chat-header">
        <div className="chat-title-line">
          <div className="chat-title ellipsis" title={sessionId}>
            {summary?.title ?? 'Loading session…'}
          </div>
          {summary?.agentType && (
            <span className={`agent-badge ${summary.agentType}`}>
              [{summary.agentType}]
            </span>
          )}
        </div>
        <div className="chat-meta">
          <span>{displayPath(workspace)}</span>

          <div className="chat-header-actions">
            {context && <ContextRing context={context} />}
            <button
              type="button"
              className="icon-button"
              onClick={() => void handleCompact()}
              disabled={running || compacting}
              title="compact context"
            >
              {compacting ? 'Compacting…' : 'Compact context'}
            </button>
          </div>
        </div>
      </div>
      {goal && (
        <div className="goal-panel" aria-label="Current goal">
          <div className="goal-panel-line">
            <strong>Goal · {goal.status}</strong>
            <span className="goal-objective">{goal.objective}</span>
            <span>{goal.rounds}/{goal.maxRounds} rounds</span>
            {(goal.status === 'active' || goal.status === 'paused' || goal.status === 'blocked') && (
              <button
                type="button"
                className="goal-action"
                disabled={running || slashBusy}
                onClick={() => void runSlash('/goal', [goal.status === 'active' ? 'pause' : 'resume'])}
              >
                {goal.status === 'active' ? 'Pause' : 'Resume'}
              </button>
            )}
          </div>
          <div className="goal-progress" role="progressbar" aria-label="Goal rounds" aria-valuenow={goal.rounds} aria-valuemin={0} aria-valuemax={goal.maxRounds}>
            <span style={{ width: `${Math.min(100, (goal.rounds / goal.maxRounds) * 100)}%` }} />
          </div>
          {goal.detail && <small>{goal.detail}</small>}
        </div>
      )}
      <div className="messages-viewport">
        <div
          className="conversation-scroll"
          ref={scrollRef}
          onScroll={handleMessagesScroll}
        >
          <div className="messages">
            {messages.length === 0 && (
              <div className="conversation-welcome">
                <Code2 size={28} strokeWidth={1.4} />
                <h2>Let’s work on your code.</h2>
                <p>Describe a task, ask a question, or type / for commands.</p>
              </div>
            )}
            {renderItems.map((item) => {
              if (item.kind === 'tools') {
                return (
                  <ToolGroupBlock
                    key={`tools-${item.tools[0]?.id ?? 'empty'}`}
                    tools={item.tools}
                  />
                )
              }
              const { message, sourceIndex } = item
              return (
                <MessageBlock
                  key={message.id}
                  message={message}
                  active={
                    message.role === 'user' &&
                    userIndexes[navIndex] === sourceIndex
                  }
                  userRef={
                    message.role === 'user'
                      ? (node) => {
                          if (node) userRefs.current.set(message.id, node)
                          else userRefs.current.delete(message.id)
                        }
                      : undefined
                  }
                  editing={editingId === message.id}
                  editDraft={editingId === message.id ? editDraft : ''}
                  onEditDraftChange={setEditDraft}
                  onBeginEdit={
                    message.role === 'user' && !running && !compacting
                      ? () => beginEdit(message)
                      : undefined
                  }
                  onSubmitEdit={
                    message.role === 'user' && editingId === message.id
                      ? () => void submitEdit()
                      : undefined
                  }
                  onCancelEdit={
                    message.role === 'user' && editingId === message.id
                      ? cancelEdit
                      : undefined
                  }
                  onForkAt={
                    message.role === 'user' && !running && !compacting
                      ? () => forkHere(message.id)
                      : undefined
                  }
                  onOpenSubagent={message.role === 'subagent' ? openSubagent : undefined}
                  subagentStatus={message.subagent?.id
                    ? subagents.find(child => child.id === message.subagent?.id)?.status
                    : undefined}
                />
              )
            })}
            {runState === 'cancelling' && (
              <div className="run-note">cancelling</div>
            )}
            {compacting && (
              <div className="run-note">compacting context...</div>
            )}
          </div>
          <div className="composer-surface" ref={composerSurfaceRef}>
            {runError && (
              <div className="error-banner" role="alert">
                <span className="marker">[!]</span>
                <span>{runError}</span>
                <button
                  type="button"
                  onClick={() => setRunError(null)}
                  title="dismiss"
                >
                  [x]
                </button>
              </div>
            )}
            <ComposerFrame
              accessory={<PlanPanel plan={plan} />}
              model={model}
              workspace={workspace}
              apiKeySet={apiKeySet}
              onSettings={onSettings}
              permission={permission}
              onPermission={setPermission}
              disabled={running || compacting}
              mode={isCoding ? mode : undefined}
              onMode={onModeChange}
            >
              {isCoding && slashMenuVisible && (
                <div
                  className="slash-menu"
                  role="listbox"
                  aria-label="slash commands"
                >
                  {slashSubmenu ? (
                    <>
                      <div className="slash-menu-header">
                        <button
                          type="button"
                          className="slash-back"
                          onClick={closeSlashSubmenu}
                          title="back to commands"
                        >
                          [back]
                        </button>
                        <span className="slash-menu-command">
                          {slashSubmenu.command.name}
                        </span>
                        <span className="slash-menu-hint">select to run</span>
                      </div>
                      {slashSubmenu.busy && (
                        <div className="slash-note">loading...</div>
                      )}
                      {slashSubmenu.error && (
                        <div className="slash-note error">
                          {slashSubmenu.error}
                        </div>
                      )}
                      {!slashSubmenu.busy && !slashSubmenu.error && (
                        <>
                          <button
                            type="button"
                            className="slash-option"
                            role="option"
                            onClick={() =>
                              chooseSlashSuggestion({
                                command: slashSubmenu.command.name,
                                args: [],
                                label: slashSubmenu.command.name,
                                detail: slashSubmenu.command.description,
                              })
                            }
                          >
                            <span className="slash-option-label">
                              {slashSubmenu.command.name}
                            </span>
                            <span className="slash-option-detail">
                              {slashSubmenu.command.description}
                            </span>
                          </button>
                          {slashSubmenu.candidates.length === 0 && (
                            <div className="slash-note">nothing available</div>
                          )}
                          {slashSubmenu.candidates.map((candidate) => (
                            <button
                              key={`${candidate.command}-${candidate.args.join(' ')}-${candidate.label}`}
                              type="button"
                              className="slash-option"
                              role="option"
                              onClick={() => chooseSlashSuggestion(candidate)}
                            >
                              <span className="slash-option-label">
                                {candidate.label}
                              </span>
                              {candidate.detail && (
                                <span className="slash-option-detail">
                                  {candidate.detail}
                                </span>
                              )}
                            </button>
                          ))}
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      {slashBusy && (
                        <div className="slash-note">loading commands...</div>
                      )}
                      {slashError && (
                        <div className="slash-note error">{slashError}</div>
                      )}
                      {!slashBusy &&
                        !slashError &&
                        slashCommands.length === 0 && (
                          <div className="slash-note">no commands</div>
                        )}
                      {!slashBusy &&
                        !slashError &&
                        slashCommands.map((command) => (
                          <button
                            key={command.name}
                            type="button"
                            className="slash-command"
                            role="option"
                            onClick={() => selectSlashCommand(command)}
                          >
                            <span className="slash-name">{command.name}</span>
                            <span className="slash-description">
                              {command.description}
                            </span>
                          </button>
                        ))}
                    </>
                  )}
                </div>
              )}
              <textarea
                ref={composerRef}
                value={prompt}
                onChange={(event) => {
                  setPrompt(event.target.value)
                  setSlashSubmenu(null)
                }}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault()
                    void startRun()
                  }
                }}
                aria-label="Message Tnega"
                placeholder="Ask Tnega to build, fix, or explore…"
                rows={2}
                // Kept typable during a run: `startRun` already refuses to send
                // while running, so the draft survives instead of the box going
                // dead on the user.
                disabled={compacting}
                spellCheck={false}
              />
              <div className="composer-actions">
                {running ? (
                  <IconButton
                    type="button"
                    className="button-danger send-button"
                    aria-label="Stop response"
                    title="Stop response"
                    onClick={cancelRun}
                    disabled={runState !== 'running'}
                  >
                    <Square size={15} fill="currentColor" />
                  </IconButton>
                ) : (
                  <IconButton
                    type="button"
                    className="button-primary send-button"
                    aria-label="Send message"
                    title="Send message (Enter)"
                    onClick={() => void startRun()}
                    disabled={
                      !prompt.trim() || !apiKeySet || compacting || slashBusy
                    }
                  >
                    <ArrowUp size={18} />
                  </IconButton>
                )}
              </div>
            </ComposerFrame>
            <div className="conversation-footer">
              <UsageMetrics context={context} metrics={metrics} />
              <button
                type="button"
                className={`subagent-toggle${showSubagents && subagents.length > 0 ? ' active' : ''}`}
                aria-label={`Show tasks: ${activeSubagents} active, ${subagents.length} total`}
                aria-expanded={showSubagents && subagents.length > 0}
                aria-controls="subagent-sidebar"
                disabled={subagents.length === 0}
                onClick={() => setShowSubagents(open => !open)}
              >
                <ListTodo size={14} aria-hidden="true" />
                {activeSubagents} active task{activeSubagents === 1 ? '' : 's'}
                {subagents.length > 0 && <span className="subagent-total">· {subagents.length} total</span>}
              </button>
            </div>
          </div>
        </div>
        <ConversationNav
          turns={userIndexes.map((index) => messages[index])}
          index={navIndex}
          onSelect={(index) => {
            setNavIndex(index)
            scrollToUserMessage(index)
          }}
        />
        {showJump && (
          <button
            type="button"
            className="jump-bottom"
            onClick={jumpToBottom}
            title="back to bottom"
            aria-label="Back to latest message"
          >
            <ChevronDown size={16} />
          </button>
        )}
      </div>
      </div>
      {showSubagents && subagents.length > 0 && (
        <SubagentSidebar
          key={sessionId}
          workspace={workspace}
          subagents={subagents}
          selectedId={selectedSubagentId}
          onSelect={setSelectedSubagentId}
          onClose={() => setShowSubagents(false)}
        />
      )}
    </div>
  )
}

function findPendingAssistant(
  messages: DisplayMessage[],
): DisplayMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index]
    if (entry && entry.role === 'assistant' && entry.pending) return entry
  }
  return undefined
}

function lastAssistant(messages: DisplayMessage[]): DisplayMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index]
    if (entry && entry.role === 'assistant') return entry
  }
  return undefined
}

function messageOf(reason: unknown): string {
  if (reason instanceof Error) return reason.message
  return String(reason)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
