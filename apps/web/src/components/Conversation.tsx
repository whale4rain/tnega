import { completionObserver, notifyDesktopWaiting } from '../lib/desktop-completion'
import {
  ArrowDown,
  Check,
  Copy,
  Link,
  ChevronDown,
  CircleDashed,
  GitBranch,
  ListChecks,
  MoreHorizontal,
  Pencil,
  Shrink,
  ShieldQuestion,
  Target,
  Trash2,
  X,
  PanelLeft,
  Code2,
  Bug,
  FlaskConical,
  Telescope,
  Lightbulb,
  PenLine,
  Languages,
  FileSpreadsheet,
  FileText,
  Presentation,
  Table2,
  PanelRight,
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError, streamRun } from '../lib/api'
import { sessionLink } from '@tnega/client/session-link'
import { ComputerHint } from './ComputerHint'

import { MxcHint } from './MxcHint'
import { copyToClipboard, errorText, folderName, useScrollPinning, useStableCallback } from '../lib/hooks'
import { inTitleBar } from '../lib/desktop-chrome'
import { confirmDialog } from '../lib/dialogs'
import { MAX_IMAGES_PER_MESSAGE } from '../lib/attachments'
import { base64FromFile } from '../lib/attached-files'
import { applyStream, beginRun, formatTokens, fromEvents, keepUnchanged, noteSettingChange, settingChangeText, type Entry } from '../lib/timeline'
import type {
  AgentType,
  ConfigSnapshot,
  ContextUsage,
  GoalState,
  PlanItem,
  PlanPayload,
  SessionDetail,
  SessionEvent,
  SessionMetrics,
  SessionPageRange,
  SessionRecovery,
  UsageTotals,
  SessionSummary,
  SlashCommand,
  StreamEvent,
  ImageAttachment,
} from '../lib/types'
import { CLIENT_COMMANDS, mergeCommands, parseCommand } from '../lib/completion'
import { useProcessView } from '../lib/process-view'
import { Composer, SessionControls, type RunSettings } from './Composer'
import type { ArgumentSuggestion } from './PromptBox'
import { Menu } from './Menu'
import { Timeline, type TimelineActions, type TimelineAgent, type TimelineSky } from './Timeline'
import { QuestionPanel } from './QuestionPanel'
import { QueuedMessages, type QueuedMessage } from './QueuedMessages'
import { BackgroundJobs } from './BackgroundJobs'
import { LinkContext, type LinkHandlers } from '../lib/links'
import { insertIntoComposer, navigateBrowser } from '../lib/browser-live'
import { formatCost, formatRate } from '../lib/usage'

/** Transcript messages per history page; one page opens a long session. */
const HISTORY_PAGE = 50

/** Least time between two renders of a streaming run, in ms. */
const STREAM_FLUSH_MS = 80

export interface Approval {
  id: string
  tool: string
  input: string
  /** Set when a CodeMode script made the call. */
  via?: 'run_code'
  /** Set when allowing covers this scope for the rest of the Session. */
  grant?: { scope: string; label: string }
  /** Why the tool asks a person about this one call, e.g. what it could damage. */
  reason?: string
}

export function Conversation({
  workspace,
  sessionId,
  config,
  draftSettings,
  onDraftSettingsChange,
  onSessionCreated,
  onSessionsChanged,
  onSessionDeleted,
  onOpenSettings,
  onConfigSaved,
  onOpenSubagent,
  onOpenFile,
  onOpenPath,
  onOpenChange,
  onToggleWorkbench,
  workbenchOpen = false,
  changeCount,
  onBrowserActivity,
  sidebarOpen,
  onToggleSidebar,
  titleSlot,
}: {
  workspace: string
  sessionId: string | undefined
  config: ConfigSnapshot | undefined
  draftSettings: RunSettings
  onDraftSettingsChange: (patch: Partial<RunSettings>) => void
  onSessionCreated: (summary: SessionSummary) => void
  onSessionsChanged: () => void
  onSessionDeleted: (id: string) => void
  onOpenSettings: () => void
  onConfigSaved?: (config: ConfigSnapshot) => void
  onOpenSubagent: (id: string, label: string) => void
  onOpenFile: (path: string) => void
  /** Open a workspace file a reply links to in the Workbench's Files view. */
  onOpenPath?: (path: string) => void
  /** Show one changed file in the Workbench's Changes view. */
  onOpenChange?: (path: string) => void
  /** Show or hide the Workbench (files, changes, terminal, browser). */
  onToggleWorkbench?: () => void
  workbenchOpen?: boolean
  /** Files changed since the last commit, shown on the Workbench button. */
  changeCount?: number | undefined
  /** The agent started a browser tool: show the browser. */
  onBrowserActivity?: () => void
  sidebarOpen: boolean
  onToggleSidebar: () => void
  /** The desktop title-bar row over the open Workbench: the header actions move there. */
  titleSlot?: HTMLElement | null | undefined
}) {
  const [summary, setSummary] = useState<SessionSummary | undefined>()
  const [entries, setEntries] = useState<readonly Entry[]>([])
  const [context, setContext] = useState<ContextUsage | undefined>()
  const [metrics, setMetrics] = useState<SessionMetrics | undefined>()
  const [usage, setUsage] = useState<UsageTotals | undefined>()
  const [plan, setPlan] = useState<PlanPayload | undefined>()
  const [goal, setGoal] = useState<GoalState | null>(null)
  const [commands, setCommands] = useState<SlashCommand[]>([])
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [remoteRunning, setRemoteRunning] = useState(false)
  const [busy, setBusy] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [commandNotice, setCommandNotice] = useState<string>()
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [resumeVersion, setResumeVersion] = useState(0)
  const [processView, setProcessView] = useProcessView()
  const pendingResume = useRef<string | undefined>(undefined)
  const [recovery, setRecovery] = useState<SessionRecovery | undefined>()
  /** The newest transcript page: how much older history is left behind it. */
  const [page, setPage] = useState<SessionPageRange | undefined>()
  /** Transcript messages on screen: a reload asks for at least these, so older pages the reader opened stay. */
  const loadedMessages = useRef(0)
  /** Bumped whenever a read replaces the window, so an older page fetched against the old one is dropped. */
  const detailGeneration = useRef(0)
  const [loadingOlder, setLoadingOlder] = useState(false)
  /** The session whose older page is in flight; polling that session waits for it so the page is not dropped. */
  const olderInFlight = useRef<string | undefined>(undefined)
  /**
   * Messages typed while a run goes, per session: they wait for the run to end
   * and go as the next prompt, unless steered into the run first.
   */
  const [queues, setQueues] = useState<Readonly<Record<string, readonly QueuedMessage[]>>>({})
  const queuesRef = useRef(queues)
  queuesRef.current = queues
  /** A run that just ended, and whether it ended on its own (not stopped, not failed). */
  const [settled, setSettled] = useState<{ id: string; natural: boolean; at: number } | undefined>()
  const stopRequested = useRef<string | undefined>(undefined)
  /** Sessions this view already continued on its own, so a failure is not retried in a loop. */
  const autoRecovered = useRef(new Set<string>())

  /** Session id that a local stream is currently writing into. */
  const streamingFor = useRef<string | undefined>(undefined)
  const abort = useRef<AbortController | undefined>(undefined)
  const queue = useRef<StreamEvent[]>([])
  /** Cancels the pending flush of streamed frames, when one is scheduled. */
  const frame = useRef<(() => void) | undefined>(undefined)
  const lastFlush = useRef(0)
  /** The session the entries state belongs to: a switch must never show another session history. */
  const entriesFor = useRef<string | undefined>(undefined)
  /** What is on screen right now; a late response for another session must not land here. */
  const shown = useRef<{ workspace: string; sessionId: string | undefined }>({ workspace, sessionId })
  shown.current = { workspace, sessionId }

  // A local run belongs to the session that started it. Another session is
  // neither live nor stoppable, and must not receive that run stream frames.
  const streamingHere = running && streamingFor.current === sessionId
  const live = streamingHere || remoteRunning

  // Settings lines in the transcript name a model the way the picker does.
  const modelNames = useRef<(id: string) => string>(id => id)
  modelNames.current = id => config?.models.find(model => model.id === id)?.name || id
  const toEntries = useCallback(
    (events: SessionDetail['events']) => fromEvents(events, { modelName: id => modelNames.current(id) }),
    [],
  )

  /** Show a one-off confirmation; it clears itself so the transcript stays clean. */
  const showNotice = useCallback((text: string, ms = 4000) => {
    if (noticeTimer.current !== undefined) clearTimeout(noticeTimer.current)
    setCommandNotice(text)
    noticeTimer.current = setTimeout(() => {
      noticeTimer.current = undefined
      setCommandNotice(undefined)
    }, ms)
  }, [])

  const clearNotice = useCallback(() => {
    if (noticeTimer.current !== undefined) clearTimeout(noticeTimer.current)
    noticeTimer.current = undefined
    setCommandNotice(undefined)
  }, [])

  useEffect(() => () => {
    if (noticeTimer.current !== undefined) clearTimeout(noticeTimer.current)
  }, [])

  // --- loading ------------------------------------------------------------

  const applyDetail = useCallback((detail: SessionDetail): boolean => {
    // A run finishing while the user reads another session reloads its own
    // history; that answer must not replace the transcript on screen.
    if (shown.current.sessionId !== detail.summary.id || shown.current.workspace !== workspace) return false
    const sameSession = entriesFor.current === detail.summary.id
    detailGeneration.current += 1
    entriesFor.current = detail.summary.id
    loadedMessages.current = countMessages(detail.events)
    setSummary(detail.summary)
    // Unchanged turns keep their objects, so only what the reload changed re-renders.
    const next = toEntries(detail.events)
    setEntries(current => sameSession ? keepUnchanged(current, next) : next)
    setPage(detail.page)
    setContext(detail.context)
    setMetrics(detail.metrics)
    setUsage(detail.usage)
    setPlan(latestPlan(detail.events))
    setRemoteRunning(detail.running && streamingFor.current !== detail.summary.id)
    setRecovery(detail.recovery)
    rememberDetail(detailKey(workspace, detail.summary.id), detail)
    return true
  }, [workspace, toEntries])

  const reload = useCallback(async (id: string) => {
    const maxMessages = entriesFor.current === id ? Math.max(HISTORY_PAGE, loadedMessages.current) : HISTORY_PAGE
    const detail = await api.session(workspace, id, { maxMessages })
    if (!applyDetail(detail)) return detail
    if (detail.summary.mode === 'goal') {
      api.goal(workspace, id).then(result => setGoal(result.goal), () => setGoal(null))
    } else {
      setGoal(null)
    }
    return detail
  }, [workspace, applyDetail])

  useEffect(() => {
    setError(undefined)
    clearNotice()
    setApprovals([])
    if (pendingResume.current !== sessionId) pendingResume.current = undefined
    if (!sessionId) {
      setSummary(undefined)
      setEntries([])
      setContext(undefined)
      setMetrics(undefined)
      setUsage(undefined)
      setPlan(undefined)
      setGoal(null)
      setRemoteRunning(false)
      setRecovery(undefined)
      setPage(undefined)
      return
    }
    // This view already holds that session live transcript (our own send
    // started it); there is nothing to load over it. A switch back does load,
    // because the entries on screen belong to the session that was left.
    if (streamingFor.current === sessionId && entriesFor.current === sessionId) return
    if (entriesFor.current !== sessionId) {
      // A session viewed a moment ago shows at once from memory while the fresh
      // read is on its way; any other never shows the one that was left.
      const cached = recentDetails.get(detailKey(workspace, sessionId))
      if (cached) {
        // Only the transcript: whether it runs or needs recovering comes from the fresh read.
        const fresh: SessionDetail = { ...cached, running: false }
        delete fresh.recovery
        applyDetail(fresh)
      } else {
        entriesFor.current = undefined
        setEntries([])
        setPlan(undefined)
        setRecovery(undefined)
        setRemoteRunning(false)
        setPage(undefined)
      }
    }
    let cancelled = false
    setLoading(true)
    api.session(workspace, sessionId, { maxMessages: HISTORY_PAGE })
      .then(detail => {
        if (cancelled) return
        applyDetail(detail)
        if (detail.summary.mode === 'goal') api.goal(workspace, sessionId).then(r => !cancelled && setGoal(r.goal), () => {})
        else setGoal(null)
      })
      .catch(reason => !cancelled && setError(errorText(reason)))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [workspace, sessionId, applyDetail, clearNotice])

  // Poll while a run started elsewhere (another tab, the CLI) is still going.
  useEffect(() => {
    if (!remoteRunning || !sessionId) return
    // One poll at a time: reading a long log can take longer than the interval, and
    // stacked reads would keep the host busy and replace the window out of order.
    let polling = false
    const timer = setInterval(() => {
      if (polling || olderInFlight.current === sessionId) return
      polling = true
      reload(sessionId).then(detail => {
        if (detail.running) return
        onSessionsChanged()
        setSettled({ id: sessionId, natural: stopRequested.current !== sessionId, at: Date.now() })
      }, () => {}).finally(() => { polling = false })
    }, 1500)
    return () => clearInterval(timer)
  }, [remoteRunning, sessionId, reload, onSessionsChanged])

  const agentType = summary?.agentType ?? draftSettings.agentType
  useEffect(() => {
    if (!sessionId || agentType !== 'coding') {
      setCommands([])
      return
    }
    let cancelled = false
    api.slashCommands(workspace, sessionId).then(r => !cancelled && setCommands(r.commands), () => {})
    return () => {
      cancelled = true
    }
  }, [workspace, sessionId, agentType])

  // --- settings -----------------------------------------------------------

  const defaultApproval = config?.config.approvalReview?.defaultMode
  const settings: RunSettings = useMemo(() => summary
    ? {
        agentType: summary.agentType ?? 'general',
        mode: summary.mode ?? 'auto',
        permission: summary.permission ?? 'read-only',
        approvalMode: summary.approvalMode ?? defaultApproval ?? 'manual',
        model: summary.model,
        reasoningEffort: summary.reasoningEffort ?? 'default',
      }
    : draftSettings, [summary, defaultApproval, draftSettings])

  // Client commands work everywhere; coding sessions add the agent's own (skills, MCP).
  const allCommands = useMemo(() => mergeCommands(commands), [commands])
  const models = config?.models
  const completeArgument = useCallback(async (name: string, query: string): Promise<ArgumentSuggestion[]> => {
    const needle = query.toLowerCase()
    if (name === '/codemode') return [
      { value: 'on', label: 'on', detail: 'Enable CodeMode (PTC)' },
      { value: 'off', label: 'off', detail: 'Disable CodeMode' },
    ].filter(item => item.value.startsWith(needle))
    if (name === '/model') {
      return (models ?? [])
        .filter(model => !needle || model.id.toLowerCase().includes(needle) || (model.name ?? '').toLowerCase().includes(needle))
        .map(model => ({ value: model.id, label: model.name || model.id, detail: model.id }))
    }
    if (!sessionId) return []
    const { candidates } = await api.slashCandidates(workspace, sessionId, name)
    return candidates
      .filter(candidate => !needle || candidate.label.toLowerCase().includes(needle))
      .map(candidate => ({ value: candidate.args.join(' '), label: candidate.label, ...(candidate.detail ? { detail: candidate.detail } : {}) }))
  }, [models, sessionId, workspace])
  const searchFiles = useCallback(async (query: string) => (await api.searchFiles(workspace, query)).files, [workspace])
  const attachFile = useCallback(async (file: File) => (await api.uploadFile(workspace, file.name, await base64FromFile(file))).path, [workspace])

  const changeSettings = async (patch: Partial<RunSettings>) => {
    if (!summary) {
      onDraftSettingsChange(patch)
      return
    }
    // Persist agent type / permission choices as defaults for new sessions too.
    onDraftSettingsChange({
      ...(patch.agentType ? { agentType: patch.agentType } : {}),
      ...(patch.permission ? { permission: patch.permission } : {}),
      ...(patch.approvalMode ? { approvalMode: patch.approvalMode } : {}),
    })
    try {
      const { model, ...rest } = patch
      const body = { ...rest, ...(model ? { model } : {}) }
      if (!Object.keys(body).length) return
      const result = await api.patchSession(workspace, summary.id, body)
      setSummary(result.summary)
      // A change after the conversation started leaves a line in the transcript
      // (the durable log has the same line on reload). While a turn runs, the
      // step in flight keeps its settings; the next one uses the new ones.
      const text = settingChangeText({
        ...(model && model !== settings.model ? { model } : {}),
        ...(patch.reasoningEffort && patch.reasoningEffort !== settings.reasoningEffort ? { reasoningEffort: patch.reasoningEffort } : {}),
        ...(patch.permission && patch.permission !== settings.permission ? { permission: patch.permission } : {}),
        ...(patch.approvalMode && patch.approvalMode !== settings.approvalMode ? { approvalMode: patch.approvalMode } : {}),
      }, modelNames.current)
      if (text) {
        setEntries(current => current.some(entry => entry.kind === 'agent')
          ? noteSettingChange(current, `setting-${Date.now()}`, text, live)
          : current)
      }
      if (patch.mode === 'goal') api.goal(workspace, summary.id).then(r => setGoal(r.goal), () => {})
      if (patch.mode && patch.mode !== 'goal') setGoal(null)
    } catch (reason) {
      setError(errorText(reason))
    }
  }

  // --- running ------------------------------------------------------------

  const flush = useCallback(() => {
    frame.current = undefined
    lastFlush.current = performance.now()
    const events = queue.current
    if (!events.length) return
    queue.current = []
    const owner = streamingFor.current
    // A frame belongs to the session that produced it; a view showing any other
    // session - a new one without an id yet included - must not receive it.
    if (owner !== undefined && shown.current.sessionId !== owner) return
    setEntries(current => events.reduce(applyStream, current))
  }, [])

  const onBrowserActivityRef = useRef(onBrowserActivity)
  onBrowserActivityRef.current = onBrowserActivity
  const onStreamEvent = useCallback((event: StreamEvent, owner: string) => {
    // A frame, an approval or a plan belongs to the run that produced it: the
    // run in flight may have been started in another session than the one on
    // screen (or than the newest one, when a new session was started over it).
    if (owner !== streamingFor.current || shown.current.sessionId !== owner) return
    switch (event.type) {
      case 'approval/request':
        notifyDesktopWaiting(event.id)
        setApprovals(list => [...list, { id: event.id, tool: event.tool, input: event.input, ...(event.via ? { via: event.via } : {}), ...(event.grant ? { grant: event.grant } : {}), ...(event.reason ? { reason: event.reason } : {}) }])
        return
      case 'plan/start':
        setPlan({ items: [], status: 'pending' })
        return
      case 'plan/items':
      case 'plan/done':
        setPlan(event.plan)
        return
      case 'plan/item':
        setPlan(current => current && {
          ...current,
          items: current.items.map(item => item.id === event.item.id ? event.item : item),
        })
        break
      case 'tool/start':
        if (event.call.name.startsWith('browser_')) onBrowserActivityRef.current?.()
        break
      default:
        break
    }
    queue.current.push(event)
    if (frame.current) return
    // A long reply re-renders its markdown on every flush; a few flushes a
    // second read as smooth streaming and leave the page free for typing.
    const wait = Math.max(0, lastFlush.current + STREAM_FLUSH_MS - performance.now())
    let paint: number | undefined
    const timer = setTimeout(() => { paint = requestAnimationFrame(flush) }, wait)
    frame.current = () => {
      clearTimeout(timer)
      if (paint !== undefined) cancelAnimationFrame(paint)
    }
  }, [flush])

  useEffect(() => () => {
    frame.current?.()
    abort.current?.abort()
  }, [])

  const run = useCallback(async (id: string, prompt: string, base: readonly Entry[], resumeQueued = false, images: readonly ImageAttachment[] = []) => {
    const controller = new AbortController()
    const notifyCompletion = completionObserver(controller.signal)
    abort.current = controller
    streamingFor.current = id
    // This view is showing the session the run writes into, even before the
    // parent re-renders with the id of the session it just created.
    shown.current = { workspace, sessionId: id }
    setRunning(true)
    setError(undefined)
    entriesFor.current = id
    setEntries(resumeQueued ? base : beginRun(base, prompt, Date.now(), images))
    // One id for every attempt below: a retry never queues the same message twice.
    const requestId = resumeQueued ? undefined : crypto.randomUUID()
    if (stopRequested.current === id) stopRequested.current = undefined
    let natural = false
    let failed = false
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await streamRun(workspace, id, prompt, event => {
            if (event.type === 'error') failed = true
            notifyCompletion(event)
            onStreamEvent(event, id)
          }, controller.signal, resumeQueued, images, requestId)
          break
        } catch (reason) {
          // A previous run can take a moment to release the session.
          if (reason instanceof ApiError && reason.status === 409 && attempt < 10 && !controller.signal.aborted) {
            await new Promise(resolve => setTimeout(resolve, 400))
            continue
          }
          throw reason
        }
      }
      natural = !failed && stopRequested.current !== id
    } catch (reason) {
      if (!controller.signal.aborted) setError(errorText(reason))
    } finally {
      // A newer run may own the view's live state by now; only the run that
      // owns it may settle it and close its own transcript.
      if (streamingFor.current === id) {
        frame.current?.()
        flush()
        streamingFor.current = undefined
        abort.current = undefined
        setApprovals([])
        setRunning(false)
      }
      await reload(id).catch(() => {})
      onSessionsChanged()
      setSettled({ id, natural, at: Date.now() })
    }
  }, [workspace, onStreamEvent, flush, reload, onSessionsChanged])

  // A run the app stopped mid-turn: queue its continuation, then drain it like any resumed run.
  const resumeInterrupted = useCallback(async (id: string) => {
    setRecovery(undefined)
    try {
      const { resumeQueued } = await api.recover(workspace, id)
      if (resumeQueued) {
        pendingResume.current = id
        setResumeVersion(version => version + 1)
      }
    } catch (reason) {
      setError(errorText(reason))
    }
  }, [workspace])

  useEffect(() => {
    if (!sessionId || !recovery?.safe || live || autoRecovered.current.has(sessionId)) return
    autoRecovered.current.add(sessionId)
    showNotice('Continuing the run that stopped when the app closed.', 6000)
    void resumeInterrupted(sessionId)
  }, [sessionId, recovery, live, resumeInterrupted])

  useEffect(() => {
    if (live || streamingFor.current || pendingResume.current !== sessionId || !sessionId) return
    pendingResume.current = undefined
    void run(sessionId, '', entries, true)
  }, [live, sessionId, resumeVersion, entries, run])

  /** Runs a command the UI handles itself; returns undefined when `text` is not one. */
  const runClientCommand = async (text: string): Promise<boolean | undefined> => {
    const parsed = parseCommand(text)
    const spec = parsed && CLIENT_COMMANDS.find(command => command.name === parsed.name)
    if (!parsed || !spec) return undefined
    const { name, rest } = parsed
    if (name === '/codemode') {
      const option = rest.trim().toLowerCase()
      if (option && option !== 'on' && option !== 'off') {
        setError('Use /codemode on or /codemode off.')
        return false
      }
      try {
        setBusy('Saving CodeMode…')
        const saved = await api.saveConfig({ codeMode: option !== 'off' })
        onConfigSaved?.(saved)
        showNotice(saved.config.codeMode ? 'CodeMode enabled (PTC).' : 'CodeMode disabled.')
        return true
      } catch (reason) {
        setError(errorText(reason))
        return false
      } finally { setBusy(undefined) }
    }
    if (name === '/plan' || name === '/goal' || name === '/auto') {
      const mode = name === '/plan' ? 'plan' : name === '/goal' ? 'goal' : 'auto'
      await changeSettings({ mode })
      // "/plan add a chart" switches mode and sends the request in one go.
      return rest && mode !== 'auto' ? sendPrompt(rest, { ...settings, mode }) : true
    }
    if (name === '/model') {
      const needle = rest.toLowerCase()
      const model = (models ?? []).find(each => each.id.toLowerCase() === needle || (each.name ?? '').toLowerCase() === needle)
      if (!model) {
        setError(rest ? `No model called "${rest}". Type /model and a space to pick one.` : 'Type /model and a space to pick a model.')
        return false
      }
      await changeSettings({ model: model.id })
      return true
    }
    if (name === '/compact') {
      if (!sessionId) {
        setError('There is nothing to compact yet.')
        return false
      }
      await compact()
      return true
    }
    if (name === '/rename') {
      if (!sessionId || !rest) {
        setError(sessionId ? 'Give the new title after /rename.' : 'Start the conversation before renaming it.')
        return false
      }
      await rename(rest)
      return true
    }
    return undefined
  }

  /** The session a running agent writes into, when one is running here. */
  const liveSession = (): string | undefined => streamingHere ? streamingFor.current : remoteRunning ? sessionId : undefined

  const setQueue = (id: string, update: (items: readonly QueuedMessage[]) => readonly QueuedMessage[]) => {
    setQueues(current => {
      const next = update(current[id] ?? [])
      const rest = Object.fromEntries(Object.entries(current).filter(([key]) => key !== id))
      return next.length ? { ...rest, [id]: next } : rest
    })
  }

  /** Hand a message to the running agent now; it reads it at its next step. */
  const steer = async (text: string, images: readonly ImageAttachment[] = []): Promise<boolean> => {
    const id = liveSession()
    if (!id) return send(text, [...images])
    setError(undefined)
    try {
      await api.steer(workspace, id, text, images)
      showNotice('Steering sent. The agent will read it at the next step.')
      return true
    } catch (reason) {
      setError(errorText(reason))
      return false
    }
  }

  const sendQueued = async (item: QueuedMessage): Promise<void> => {
    const id = liveSession() ?? sessionId
    if (!id) return
    setQueue(id, items => items.filter(each => each.id !== item.id))
    const sent = liveSession() ? await steer(item.text, item.images) : await send(item.text, item.images)
    if (!sent) setQueue(id, items => [item, ...items])
  }

  const send = async (text: string, images: ImageAttachment[] = []): Promise<boolean> => {
    setError(undefined)
    const liveId = liveSession()
    if (liveId) {
      // Queued by default: it goes once this run ends, or now with "Steer now".
      setQueue(liveId, items => [...items, { id: crypto.randomUUID(), text, images }])
      return true
    }
    if (!images.length) {
      const handled = await runClientCommand(text)
      if (handled !== undefined) return handled
    }
    return sendPrompt(text, settings, images)
  }

  const sendPrompt = async (text: string, settings: RunSettings, images: ImageAttachment[] = []): Promise<boolean> => {
    let id = sessionId
    try {
      if (!id) {
        setBusy('Starting session…')
        const created = (await api.createSession(workspace, { agentType: settings.agentType, mode: settings.mode })).session
        const patch = {
          approvalMode: settings.approvalMode ?? 'manual',
          ...(settings.permission !== 'read-only' ? { permission: settings.permission } : {}),
          ...(settings.model ? { model: settings.model } : {}),
          ...(settings.reasoningEffort !== 'default' ? { reasoningEffort: settings.reasoningEffort } : {}),
        }
        const session = Object.keys(patch).length ? (await api.patchSession(workspace, created.id, patch)).summary : created
        id = session.id
        streamingFor.current = id
        setSummary(session)
        onSessionCreated(session)
      }
      const slash = parseCommand(text)
      if (slash && !images.length && settings.agentType === 'coding' && allCommands.some(command => command.source === 'server' && command.name === slash.name)) {
        setBusy(`Running ${slash.name}…`)
        await api.runSlash(workspace, id, slash.name, slash.rest ? slash.rest.split(/\s+/) : [])
        await reload(id)
        onSessionsChanged()
        return true
      }
    } catch (reason) {
      setError(errorText(reason))
      streamingFor.current = undefined
      return false
    } finally {
      setBusy(undefined)
    }
    void run(id, text, sessionId ? entries : [], false, images)
    return true
  }

  const stop = async () => {
    const id = streamingHere ? streamingFor.current : sessionId
    if (!id) return
    stopRequested.current = id
    const controller = abort.current
    try {
      await api.stop(workspace, id)
    } catch {
      // Falling back to disconnecting is enough to cancel the run.
    }
    setTimeout(() => controller?.abort(), 2500)
    if (remoteRunning) void reload(id)
  }

  // A run that ended on its own takes its queue as the next prompt; a stopped or
  // failed one leaves it waiting, since what was queued may no longer apply.
  const sendRef = useRef(send)
  sendRef.current = send
  useEffect(() => {
    if (!settled || settled.id !== sessionId || live) return
    const items = queuesRef.current[settled.id] ?? []
    setSettled(undefined)
    if (!items.length) return
    if (!settled.natural) {
      showNotice('Your queued messages are waiting: send, edit or remove them.', 6000)
      return
    }
    const id = settled.id
    setQueue(id, () => [])
    const text = items.map(item => item.text).filter(Boolean).join('\n\n')
    const images = items.flatMap(item => item.images).slice(0, MAX_IMAGES_PER_MESSAGE)
    void sendRef.current(text, images).then(sent => {
      if (!sent) setQueue(id, current => [...items, ...current])
    })
  }, [settled, sessionId, live, showNotice])

  const resend = async (entryId: string, text: string) => {
    if (!sessionId || live) return
    try {
      setBusy('Rewinding…')
      await api.truncate(workspace, sessionId, entryId)
      const detail = await reload(sessionId)
      setBusy(undefined)
      void run(sessionId, text, toEntries(detail.events))
    } catch (reason) {
      setBusy(undefined)
      setError(errorText(reason))
    }
  }

  const fork = async (messageId?: string) => {
    if (!sessionId) return
    try {
      const { session } = await api.forkSession(workspace, sessionId, messageId)
      onSessionCreated(session)
    } catch (reason) {
      setError(errorText(reason))
    }
  }

  const compact = async () => {
    if (!sessionId) return
    try {
      setBusy('Compacting context…')
      await api.compact(workspace, sessionId)
      await reload(sessionId)
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(undefined)
    }
  }

  const rename = async (title: string) => {
    if (!sessionId || !title.trim()) return
    try {
      const result = await api.patchSession(workspace, sessionId, { title: title.trim() })
      setSummary(result.summary)
      onSessionsChanged()
    } catch (reason) {
      setError(errorText(reason))
    }
  }

  /** Set when a reload made an older page stale, so the fill effect asks again. */
  const droppedOlder = useRef(false)
  /** Prepend the page before the window on screen, holding the reader in place. */
  const loadOlder = async () => {
    if (!sessionId || !page?.hasMore || loadingOlder) return
    const element = scroller.current
    const id = sessionId
    const generation = detailGeneration.current
    setLoadingOlder(true)
    olderInFlight.current = id
    try {
      const detail = await api.session(workspace, id, { beforeSeq: page.beforeSeq, maxMessages: HISTORY_PAGE })
      // The reader may have switched sessions while the page was in flight.
      if (shown.current.sessionId !== id) return
      // A reload replaced the window meanwhile (a run ended, a remote run was polled): this
      // page may no longer join it. Drop it; the fill effect asks again from the new window.
      if (detailGeneration.current !== generation) {
        droppedOlder.current = true
        return
      }
      // Measured now, not before the request: the reader may have scrolled while it ran.
      const anchor = element ? readingAnchor(element) : undefined
      const older = toEntries(detail.events)
      loadedMessages.current += countMessages(detail.events)
      setEntries(current => [...older, ...current])
      setPage(detail.page)
      // Keep what the reader was looking at where they left it. The browser's
      // own scroll anchoring may already have done so; measuring the element
      // itself keeps this right either way.
      if (element && anchor) pendingAnchor.current = { element, ...anchor }
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      if (olderInFlight.current === id) olderInFlight.current = undefined
      setLoadingOlder(false)
    }
  }

  const remove = async () => {
    if (!sessionId) return
    if (!await confirmDialog({
      title: 'Delete session?',
      message: `“${summary?.title || 'This session'}” will be deleted. This can't be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    })) return
    try {
      await api.deleteSession(workspace, sessionId)
      onSessionDeleted(sessionId)
    } catch (reason) {
      setError(errorText(reason))
    }
  }

  const answer = async (approval: Approval, allow: boolean) => {
    const id = streamingHere ? streamingFor.current : sessionId
    if (!id) return
    setApprovals(list => list.filter(item => item.id !== approval.id))
    try {
      await api.approve(workspace, id, approval.id, allow)
    } catch (reason) {
      setError(errorText(reason))
    }
  }

  // --- scrolling ----------------------------------------------------------

  const { scroller, showJump, onScroll, jump, pinToEnd } = useScrollPinning()
  const pendingAnchor = useRef<{ element: HTMLElement; node: Element; offset: number } | undefined>(undefined)
  useLayoutEffect(() => {
    const pending = pendingAnchor.current
    if (!pending) return
    pendingAnchor.current = undefined
    if (!pending.node.isConnected) return
    const drift = pending.node.getBoundingClientRect().top - pending.element.getBoundingClientRect().top - pending.offset
    if (drift) pending.element.scrollTop += drift
  }, [entries])
  useEffect(() => { pinToEnd() }, [sessionId, pinToEnd])

  // Older history loads when the reader reaches the top, not on a button. A page
  // that does not fill the viewport has no scroll event to wait for, so it keeps
  // filling until the transcript can scroll or the history ends. A reader still at
  // the top asks again too, so a page dropped by a reload does not wait for a scroll.
  const loadOlderRef = useRef(loadOlder)
  loadOlderRef.current = loadOlder
  useEffect(() => {
    const element = scroller.current
    if (!element || !page?.hasMore || loadingOlder) return
    const fits = element.scrollHeight > 0 && element.scrollHeight <= element.clientHeight + 1
    const retry = droppedOlder.current && element.scrollTop <= 96
    droppedOlder.current = false
    if (fits || retry) {
      void loadOlderRef.current()
    }
  }, [entries.length, page, loadingOlder])

  const onScrollWithPaging = (event: React.UIEvent<HTMLDivElement>) => {
    onScroll()
    if (event.currentTarget.scrollTop <= 96) void loadOlderRef.current()
  }

  // --- render -------------------------------------------------------------

  // The Timeline and each of its turns are memoized: props that keep their
  // identity across renders let a streamed frame re-render only the live turn,
  // instead of every message (and its markdown) in a long session.
  const actionsRef = useRef({ resend, fork, onOpenSubagent, onOpenFile, onOpenChange })
  useLayoutEffect(() => {
    actionsRef.current = { resend, fork, onOpenSubagent, onOpenFile, onOpenChange }
  })
  const canOpenChange = Boolean(onOpenChange)
  const timelineActions = useMemo<TimelineActions>(() => ({
    onEdit: (entryId, text) => void actionsRef.current.resend(entryId, text),
    onRetry: (entryId, text) => void actionsRef.current.resend(entryId, text),
    onFork: messageId => void actionsRef.current.fork(messageId),
    onOpenSubagent: (id, label) => actionsRef.current.onOpenSubagent(id, label),
    onOpenFile: path => actionsRef.current.onOpenFile(path),
    ...(canOpenChange ? { onOpenChange: (path: string) => actionsRef.current.onOpenChange?.(path) } : {}),
  }), [canOpenChange])
  const agentId = summary?.id ?? streamingFor.current ?? 'draft'
  const timelineAgent = useMemo<TimelineAgent>(() => ({ id: agentId, role: 'coordinator' }), [agentId])
  const waiting = approvals.length > 0
  const contextRatio = context && context.limit > 0 ? context.ratio : undefined
  const sky = useMemo<TimelineSky>(() => ({
    waiting,
    ...(contextRatio !== undefined ? { contextRatio } : {}),
  }), [waiting, contextRatio])

  const links = useMemo<LinkHandlers>(() => ({
    workspace,
    ...(onOpenPath ? { openPath: onOpenPath } : {}),
    ...(onBrowserActivity ? { openLocalUrl: (url: string) => { onBrowserActivity(); void navigateBrowser(url).catch(() => undefined) } } : {}),
  }), [workspace, onOpenPath, onBrowserActivity])
  const apiKeyMissing = config !== undefined && !config.apiKeySet && !(config.models.some(model => model.apiKeySet))
  const empty = !loading && entries.length === 0
  const title = summary?.title || (sessionId ? 'Untitled session' : 'New session')

  const disabledReason = useMemo(() => apiKeyMissing
    ? <>No model API key is configured. <button type="button" className="link-button inline" onClick={onOpenSettings}>Open settings</button></>
    : busy, [apiKeyMissing, busy, onOpenSettings])
  // The composer is memoized so a streamed frame or a scroll does not re-render it while you type.
  const onComposerSettings = useStableCallback((patch: Partial<RunSettings>) => void changeSettings(patch))
  const onComposerSubmit = useStableCallback(send)
  const onComposerSteer = useStableCallback(steer)
  const onComposerStop = useStableCallback(() => void stop())

  return (
    <main className="conversation">
      <header className="conv-header">
        {/* Always rendered: it folds away while the sidebar is open, so the title glides instead of jumping. */}
        <button type="button" className="icon-button header-sidebar-toggle" onClick={onToggleSidebar} aria-label="Show sidebar" title="Show sidebar (Ctrl+B)"
          aria-hidden={sidebarOpen || undefined} tabIndex={sidebarOpen ? -1 : undefined}>
          <PanelLeft size={14} />
        </button>
        <div className="conv-title-wrap">
          <div className="conv-title-row">
            {summary ? <EditableTitle value={title} onSave={rename} /> : <h1 className="conv-title">{title}</h1>}
          </div>
          <div className="conv-subtitle">
            <span className="conv-workspace" title={workspace}>{folderName(workspace)}</span>
            {summary?.parentSessionId && <span className="conv-tag"><GitBranch size={12} /> fork</span>}
            {goal && <GoalPill goal={goal} />}
          </div>
        </div>
        {inTitleBar(titleSlot, <div className="conv-header-actions">
          <div className="header-group">
            <SessionControls settings={settings} onSettingsChange={patch => void changeSettings(patch)} locked={live || Boolean(busy)} accessLocked={Boolean(busy)} />
          </div>
          <div className="header-group header-tools">
          {sessionId && <BackgroundJobs key={`${workspace}:${sessionId}`} workspace={workspace} sessionId={sessionId} onOpenBrowser={onBrowserActivity} />}
          {context && context.limit > 0 && <ContextMeter context={context} metrics={metrics} usage={usage} />}
          {onToggleWorkbench && (
            <button
              type="button"
              className={`icon-button small header-icon${workbenchOpen ? ' active' : ''}`}
              onClick={onToggleWorkbench}
              aria-label={workbenchOpen ? 'Hide workbench' : `Show workbench${changeCount ? ` (${changeCount} changed files)` : ''}`}
              aria-pressed={workbenchOpen}
              title={changeCount ? `Workbench · ${changeCount} changed ${changeCount === 1 ? 'file' : 'files'} (Ctrl+J)` : 'Workbench (Ctrl+J)'}
            >
              <PanelRight size={14} />
              {changeCount !== undefined && changeCount > 0 && <span className="count-badge live" aria-hidden>{changeCount > 99 ? '99+' : changeCount}</span>}
            </button>
          )}
          {summary && (
            <Menu
              label="Session actions"
              align="end"
              className="icon-button small header-icon"
              trigger={<MoreHorizontal size={14} />}
              items={[
                { key: 'fork', label: 'Fork entire session', icon: <GitBranch size={14} />, onSelect: () => void fork(), disabled: live },
                { key: 'copy-link', label: 'Copy session link', icon: <Link size={14} />, onSelect: () => copyToClipboard(sessionLink(workspace, summary.id)) },
                { key: 'copy-id', label: 'Copy session ID', icon: <Copy size={14} />, onSelect: () => copyToClipboard(summary.id) },
                { key: 'compact', label: 'Compact context', icon: <Shrink size={14} />, onSelect: () => void compact(), disabled: live || entries.length === 0 },
                'separator',
                { key: 'delete', label: 'Delete session', icon: <Trash2 size={14} />, danger: true, onSelect: () => void remove(), disabled: live },
              ]}
            />
          )}
          </div>
        </div>)}
      </header>

      <div className="conv-scroll" ref={scroller} onScroll={onScrollWithPaging}>
        <div className="conv-column">
          <ComputerHint enabled={config?.config.computerUse === true} />

          <MxcHint />
          {loading && entries.length === 0 && <TimelineSkeleton />}
          {busy === 'Compacting context…' && <div className="notice notice-info" role="status">Compacting context…</div>}
          {empty && (
            <EmptyState
              workspace={workspace}
              agentType={settings.agentType}
              onPick={prompt => void send(prompt)}
              disabled={Boolean(disabledReason)}
            />
          )}
          {loadingOlder && (
            <div className="load-older" role="status">Loading older messages…</div>
          )}
          <LinkContext.Provider value={links}>
          <Timeline
            entries={entries}
            running={live}
            actions={timelineActions}
            agent={timelineAgent}
            processView={processView}
            onProcessViewChange={setProcessView}
            sky={sky}
          />
          </LinkContext.Provider>
          {remoteRunning && !streamingHere && (
            <div className="notice notice-info remote-run">
              <CircleDashed size={14} className="spin-slow" />
              <span>This session is running elsewhere. Updates appear automatically.</span>
            </div>
          )}
        </div>
      </div>

      <div className="conv-dock">
        <div className="conv-column">
          {showJump && (
            <button type="button" className="jump-button" onClick={jump} aria-label="Jump to latest">
              <ArrowDown size={14} />
            </button>
          )}
          {error && (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <button type="button" className="icon-button tiny" aria-label="Dismiss" onClick={() => setError(undefined)}><X size={14} /></button>
            </div>
          )}
          {commandNotice && <div className="notice notice-info" role="status">{commandNotice}</div>}
          {sessionId && recovery && !recovery.safe && !live && (
            <div className="notice notice-warn recovery-notice" role="status">
              <span>
                The last run stopped when the app closed.
                {recovery.uncertainCalls.length > 0 && ` ${recovery.uncertainCalls.join(', ')} may already have taken effect, so the agent will check before repeating it.`}
              </span>
              <button type="button" className="button small secondary" onClick={() => void resumeInterrupted(sessionId)}>Resume</button>
            </div>
          )}
          {approvals.map(approval => (
            <ApprovalCard key={approval.id} approval={approval} onAnswer={allow => void answer(approval, allow)} />
          ))}
          {sessionId && <QuestionPanel key={`${workspace}:${sessionId}`} workspace={workspace} sessionId={sessionId} running={live} onResumeQueued={() => { pendingResume.current = sessionId; setResumeVersion(version => version + 1) }} />}
          {plan && (plan.items.length > 0 || plan.status === 'pending') && <PlanPanel plan={plan} />}
          {sessionId && (
            <QueuedMessages
              items={queues[sessionId] ?? []}
              live={live}
              onSend={item => void sendQueued(item)}
              onEdit={item => {
                setQueue(sessionId, items => items.filter(each => each.id !== item.id))
                insertIntoComposer({ text: item.text, images: item.images })
              }}
              onRemove={item => setQueue(sessionId, items => items.filter(each => each.id !== item.id))}
            />
          )}
          <Composer
            settings={settings}
            onSettingsChange={onComposerSettings}
            models={config?.models ?? NO_MODELS}
            defaultModelId={config?.effective.modelId}
            config={config}
            onConfigChanged={onConfigSaved}
            commands={allCommands}
            completeArgument={completeArgument}
            searchFiles={searchFiles}
            attachFile={attachFile}
            running={live}
            allowWhileRunning
            locked={live || Boolean(busy)}
            modelLocked={Boolean(busy)}
            disabledReason={disabledReason}
            onSubmit={onComposerSubmit}
            onSteerSubmit={onComposerSteer}
            onStop={onComposerStop}
            placeholder={live ? 'Queue a message for after this run… (Ctrl+Enter steers now)' : sessionId ? 'Reply… (/ for commands, @ for files)' : PLACEHOLDERS[settings.agentType]}
            autoFocusKey={sessionId ?? 'draft'}
            resetKey={`${workspace}:${sessionId ?? 'draft'}`}
          />
        </div>
      </div>
    </main>
  )
}

const NO_MODELS: ConfigSnapshot['models'] = []

/** The newest page of the sessions viewed last, so switching back to one shows it at once. */
const recentDetails = new Map<string, SessionDetail>()
const RECENT_DETAILS = 6

function detailKey(workspace: string, id: string): string {
  return `${workspace}\n${id}`
}

function rememberDetail(key: string, detail: SessionDetail): void {
  recentDetails.delete(key)
  recentDetails.set(key, detail)
  while (recentDetails.size > RECENT_DETAILS) {
    const oldest = recentDetails.keys().next().value
    if (oldest === undefined) break
    recentDetails.delete(oldest)
  }
}

/** The first transcript row in view, and how far below the top of the viewport it sits. */
function readingAnchor(scroller: HTMLElement): { node: Element; offset: number } | undefined {
  const top = scroller.getBoundingClientRect().top
  for (const node of scroller.querySelectorAll('.timeline > *')) {
    const rect = node.getBoundingClientRect()
    if (rect.bottom > top) return { node, offset: rect.top - top }
  }
  return undefined
}

function countMessages(events: readonly SessionEvent[]): number {
  return events.filter(event => event.type === 'user/message' || event.type === 'assistant/message').length
}

function latestPlan(events: readonly SessionEvent[]): PlanPayload | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type === 'plan') return event.payload
  }
  return undefined
}

// ---------------------------------------------------------------------------

function EditableTitle({ value, onSave }: { value: string; onSave: (value: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  if (!editing) {
    return (
      <button type="button" className="conv-title editable" onClick={() => { setDraft(value); setEditing(true) }} title="Rename">
        <span>{value}</span>
        <Pencil size={12} className="edit-hint" />
      </button>
    )
  }
  const commit = () => {
    setEditing(false)
    if (draft.trim() && draft.trim() !== value) onSave(draft)
  }
  return (
    <input
      className="conv-title-input"
      value={draft}
      autoFocus
      aria-label="Session title"
      onChange={event => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={event => {
        if (event.key === 'Enter') commit()
        if (event.key === 'Escape') setEditing(false)
      }}
    />
  )
}

function ContextMeter({ context, metrics, usage }: { context: ContextUsage; metrics: SessionMetrics | undefined; usage: UsageTotals | undefined }) {
  const ratio = Math.min(1, Math.max(0, context.ratio))
  const tone = ratio > 0.85 ? 'danger' : ratio > 0.65 ? 'warn' : 'ok'
  const r = 6
  const c = 2 * Math.PI * r
  const percent = Math.round(ratio * 100)
  const tokens = usage ?? metrics
  const cost = formatCost(usage?.cost)
  const hitRate = formatRate(usage?.cacheHitRate ?? metrics?.cacheHitRate)
  return (
    <div className={`context-meter tone-${tone}`} tabIndex={0} aria-label={`Context ${percent}% used${cost ? `, ${cost} spent` : ''}`}>
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
        <circle cx="8" cy="8" r={r} className="ring-track" />
        <circle cx="8" cy="8" r={r} className={`ring-fill tone-${tone}`} strokeDasharray={`${c * ratio} ${c}`} transform="rotate(-90 8 8)" />
      </svg>
      <div className="context-pop" role="tooltip">
        <div className="context-pop-row"><span>Context</span><strong>{percent}% · {formatTokens(context.tokens)} / {formatTokens(context.limit)}</strong></div>
        {tokens && tokens.responses > 0 && (
          <>
            <div className="context-pop-sep" />
            <div className="context-pop-row"><span>Input tokens</span><strong>{formatTokens(tokens.promptTokens)}</strong></div>
            {tokens.cachedTokens > 0 && <div className="context-pop-row sub"><span>from cache</span><strong>{formatTokens(tokens.cachedTokens)}</strong></div>}
            {hitRate && <div className="context-pop-row"><span>Cache hit rate</span><strong>{hitRate}</strong></div>}
            <div className="context-pop-row"><span>Output tokens</span><strong>{formatTokens(tokens.completionTokens)}</strong></div>
            {usage && usage.reasoningTokens > 0 && <div className="context-pop-row sub"><span>reasoning</span><strong>{formatTokens(usage.reasoningTokens)}</strong></div>}
            <div className="context-pop-row"><span>Responses</span><strong>{tokens.responses}</strong></div>
            {metrics?.tokensPerSecond !== undefined && <div className="context-pop-row"><span>Speed</span><strong>{Math.round(metrics.tokensPerSecond)} tok/s</strong></div>}
            <div className="context-pop-row"><span>Estimated cost</span><strong>{cost ?? '—'}</strong></div>
          </>
        )}
        <div className="context-pop-note">
          {context.source === 'provider' ? 'Context reported by the model provider' : 'Context estimated'}
          {tokens && tokens.responses > 0 && !cost ? ' · add prices to this model in Settings → Models to see cost' : ''}
        </div>
      </div>
    </div>
  )
}

function GoalPill({ goal }: { goal: GoalState }) {
  return (
    <span className={`conv-tag goal-${goal.status}`} title={goal.objective}>
      <Target size={12} /> Goal {goal.status} · round {goal.rounds}/{goal.maxRounds}
    </span>
  )
}

export function ApprovalCard({ approval, onAnswer }: { approval: Approval; onAnswer: (allow: boolean) => void }) {
  return (
    <div className="approval-card" role="alertdialog" aria-label="Permission request">
      <div className="approval-head">
        <ShieldQuestion size={14} />
        {approval.grant
          ? <span>The agent wants to <strong>{approval.grant.label}</strong></span>
          : <span>The agent wants to use <strong>{approval.tool}</strong>{approval.via === 'run_code' ? ' from a CodeMode script' : ''}</span>}
      </div>
      {approval.input && <pre className="approval-input">{approvalText(approval.input)}</pre>}
      {approval.reason && (
        <p className="approval-escalation"><strong>The agent flagged a risk</strong>: {approval.reason}</p>
      )}
      {escalation(approval.input) && (
        <p className="approval-escalation">
          <strong>Runs outside the sandbox</strong>, with your full access{escalation(approval.input)?.justification ? `: ${escalation(approval.input)?.justification}` : '.'}
        </p>
      )}
      <div className="approval-actions">
        <span className="muted small">{approval.grant ? `First call: ${approval.tool}` : approval.reason ? 'Asks you about this one call' : escalation(approval.input) ? 'Asks to leave the sandbox for this one call' : 'Outside the current permission level'}</span>
        <button type="button" className="button ghost small" onClick={() => onAnswer(false)}>Deny</button>
        <button type="button" className="button primary small" onClick={() => onAnswer(true)}>{approval.grant ? 'Allow in this session' : 'Allow once'}</button>
      </div>
    </div>
  )
}

/** Whether a request asks to run outside the sandbox, and why. */
function escalation(input: string): { justification?: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(input)
    if (!parsed || typeof parsed !== 'object' || Reflect.get(parsed, 'escalate') !== true) return undefined
    const justification: unknown = Reflect.get(parsed, 'justification')
    return typeof justification === 'string' && justification.trim() ? { justification: justification.trim() } : {}
  } catch {
    return undefined
  }
}

/** Keep the command readable without hiding parameters that affect execution. */
function approvalText(input: string): string {
  try {
    const parsed: unknown = JSON.parse(input)
    if (parsed && typeof parsed === 'object') {
      const command: unknown = Reflect.get(parsed, 'command')
      if (typeof command === 'string') {
        const parameters = Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== 'command'))
        return `$ ${command}${Object.keys(parameters).length ? `\n\n${JSON.stringify(parameters, null, 2)}` : ''}`
      }
      return JSON.stringify(parsed, null, 2)
    }
  } catch {
    // Plain text input.
  }
  return input
}

function PlanPanel({ plan }: { plan: PlanPayload }) {
  const [open, setOpen] = useState(true)
  const done = plan.items.filter(item => item.status === 'done').length
  return (
    <div className={`plan-panel${open ? ' open' : ''}`}>
      <button type="button" className="plan-head" onClick={() => setOpen(v => !v)} aria-expanded={open}>
        <ListChecks size={14} />
        <span className="plan-title">{plan.summary || 'Plan'}</span>
        <span className="plan-count">{plan.items.length ? `${done}/${plan.items.length}` : 'Drafting…'}</span>
        <ChevronDown size={14} className="chevron" />
      </button>
      {open && plan.items.length > 0 && (
        <ol className="plan-items">
          {plan.items.map(item => <PlanRow key={item.id} item={item} />)}
        </ol>
      )}
    </div>
  )
}

function PlanRow({ item }: { item: PlanItem }) {
  return (
    <li className={`plan-item status-${item.status}`}>
      <span className="plan-check">
        {item.status === 'done' ? <Check size={12} strokeWidth={3} /> : item.status === 'failed' ? <X size={12} strokeWidth={3} /> : null}
      </span>
      <span>
        {item.title}
        {item.detail && <span className="plan-detail">{item.detail}</span>}
      </span>
    </li>
  )
}

function TimelineSkeleton() {
  return (
    <div className="skeleton" aria-label="Loading">
      <div className="skeleton-line right w40" />
      <div className="skeleton-line w90" />
      <div className="skeleton-line w75" />
      <div className="skeleton-line w60" />
    </div>
  )
}

const CODING_STARTERS = [
  { icon: Telescope, title: 'Map the codebase', prompt: 'Give me a tour of this codebase: the main modules, how they fit together, and where to start reading.' },
  { icon: Bug, title: 'Hunt a bug', prompt: 'Look for likely bugs or edge cases that are not handled in this project, and explain the most important ones.' },
  { icon: FlaskConical, title: 'Strengthen tests', prompt: 'Find the parts of this project with the weakest test coverage and propose focused tests for them.' },
  { icon: Code2, title: 'Review recent work', prompt: 'Review the most recent changes in this workspace and point out anything risky or unclear.' },
]

const WORK_STARTERS = [
  { icon: FileSpreadsheet, title: 'Summarize data', prompt: 'Find the CSV or Excel files in this workspace and build a summary workbook with totals by category, using formulas.' },
  { icon: FileText, title: 'Write a report', prompt: 'Read the documents in this workspace and write a concise report as a Word document.' },
  { icon: Presentation, title: 'Build a deck', prompt: 'Turn the main findings in this workspace into a short slide deck of five to seven slides.' },
  { icon: Table2, title: 'Tidy a table', prompt: 'Find messy tabular data in this workspace, clean it up, and save a tidy Excel workbook next to it.' },
]

const GENERAL_STARTERS = [
  { icon: Telescope, title: 'Explore this folder', prompt: 'Look around this workspace and summarize what is in it.' },
  { icon: PenLine, title: 'Draft a README', prompt: 'Draft a friendly README for this folder based on what it contains.' },
  { icon: Lightbulb, title: 'Brainstorm', prompt: 'Suggest five practical improvements to the contents of this workspace, most valuable first.' },
  { icon: Languages, title: 'Explain a concept', prompt: 'Explain how an AI agent uses tools, step by step, with a small concrete example.' },
]

const STARTERS: Record<AgentType, typeof GENERAL_STARTERS> = { coding: CODING_STARTERS, work: WORK_STARTERS, general: GENERAL_STARTERS }
const ROLE: Record<AgentType, string> = { coding: 'a coding agent', work: 'a work assistant', general: 'a general assistant' }
const PLACEHOLDERS: Record<AgentType, string> = {
  coding: 'Describe a change, a bug, or a question about the code…',
  work: 'Describe the spreadsheet, document or deck you need…',
  general: 'Ask anything…',
}

function EmptyState({ workspace, agentType, onPick, disabled }: { workspace: string; agentType: AgentType; onPick: (prompt: string) => void; disabled: boolean }) {
  const starters = STARTERS[agentType]
  const hour = new Date().getHours()
  const greeting = hour < 5 ? 'Working late' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  return (
    <div className="empty-state">
      <span className="brand-mark large" aria-hidden />
      <h2>{greeting}. What are we building?</h2>
      <p>
        Working in <span className="mono-chip">{folderName(workspace)}</span>
        {` as ${ROLE[agentType]}.`}
      </p>
      <div className="starter-grid">
        {starters.map(starter => (
          <button
            key={starter.title}
            type="button"
            className="starter"
            disabled={disabled}
            title={starter.prompt}
            onClick={() => onPick(starter.prompt)}
          >
            <starter.icon size={14} />
            <span className="starter-title">{starter.title}</span>
            <span className="starter-prompt">{starter.prompt}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
