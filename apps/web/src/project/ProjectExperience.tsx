import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Badge } from '@radix-ui/themes'
import { ListTodo } from 'lucide-react'
import * as api from './api'
import { Composer } from './Composer'
import { LibraryPanel, MemoryPanel, OverviewPanel } from './SidePanels'
import { ThreadPanel } from './ThreadPanel'
import { MessageBlock, latestPlanFromEvents } from './reuse'
import {
  applyStreamEvent,
  fromSnapshot,
  mergeMessage,
  threadStateLabel,
  type ProjectView,
} from './state'
import { markOf, planSteps, threadReplies, type PlanStep } from './steps'
import type { BootEnvelope, SessionEvent, ThreadRecord } from './types'
import { folderName } from '../projectSelection'

const POLL_MS = 2_000

export interface ProjectExperienceProps {
  workspace: string
  projectId: string
  models: ReadonlyArray<{ id: string; name: string }>
  model?: string | undefined
  reasoningEffort: 'default' | 'low' | 'medium' | 'high'
  onModel: (model: string) => Promise<void> | void
  onReasoningEffort: (effort: 'default' | 'low' | 'medium' | 'high') => Promise<void> | void
}

/**
 * Project 屏：和会话屏用同一套骨架 —— `.chat` 里一份内容加一个可选侧栏。
 *
 * 差别只在内容：消息来自 Box（主对话），右侧栏是某个 Thread 的执行视图。两者都是投影：
 * 消息读 Box，Thread 读 Blackboard 的记录，执行细节读那个 Agent 自己的 Session。
 */
export function ProjectExperience(props: ProjectExperienceProps) {
  const { workspace, projectId } = props
  const [view, setView] = useState<ProjectView | null>(null)
  const [connection, setConnection] = useState<{ projectId: string; cursor: number } | null>(null)
  const [panel, setPanel] = useState<'overview' | 'library' | 'memory' | null>(null)
  const [threadId, setThreadId] = useState<string | null>(null)
  const [details, setDetails] = useState<ReadonlyMap<string, SessionEvent[]>>(new Map())
  const [loadingThread, setLoadingThread] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [threadDraft, setThreadDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const selection = useRef<string | null>(null)

  useEffect(() => {
    selection.current = projectId
    setView(null)
    setConnection(null)
    setThreadId(null)
    setDetails(new Map())
    setPanel(null)
    setError(null)
    void api
      .getProject(workspace, projectId)
      .then(snapshot => {
        if (selection.current !== projectId) return
        setView(fromSnapshot(snapshot))
        // 连接从这份快照的游标开始：之后的每一条都是新消息，之前的一条都不重放。
        setConnection({ projectId, cursor: snapshot.cursor })
      })
      .catch((reason: unknown) => {
        if (selection.current === projectId) setError(messageOf(reason))
      })
  }, [workspace, projectId])

  // 一条 SSE 连接：只在「打开的 Project 变了」时重连，不会因为新消息而抖。
  useEffect(() => {
    if (!connection) return
    return api.streamProject(workspace, connection.projectId, {
      after: connection.cursor,
      onEvent: event => setView(current => (current ? applyStreamEvent(current, event) : current)),
      onError: reason => setError(messageOf(reason)),
    })
  }, [workspace, connection])

  const loadThread = useCallback(
    async (id: string, quiet: boolean): Promise<void> => {
      if (!quiet) setLoadingThread(id)
      try {
        const detail = await api.getThread(workspace, projectId, id)
        setDetails(current => new Map(current).set(id, detail.events))
      } catch (reason) {
        if (!quiet) setError(messageOf(reason))
      } finally {
        if (!quiet) setLoadingThread(null)
      }
    },
    [workspace, projectId],
  )

  // 还没结束的 Thread 才需要跟着看：它们的步骤会变。结束的留在最后一次读到的地方。
  const liveKey = (view?.threads ?? [])
    .filter(thread => thread.depth > 0 && thread.state !== 'done' && thread.state !== 'failed')
    .map(thread => thread.id)
    .sort()
    .join(' ')

  useEffect(() => {
    for (const id of liveKey ? liveKey.split(' ') : []) void loadThread(id, true)
  }, [liveKey, loadThread])

  useEffect(() => {
    if (!liveKey) return
    const timer = setInterval(() => {
      for (const id of liveKey.split(' ')) void loadThread(id, true)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [liveKey, loadThread])

  useEffect(() => {
    if (threadId) void loadThread(threadId, false)
  }, [threadId, loadThread])

  const plans = useMemo(() => {
    const map = new Map<string, PlanStep[]>()
    for (const [id, events] of details) {
      const steps = planSteps(latestPlanFromEvents(events))
      if (steps.length) map.set(id, steps)
    }
    return map
  }, [details])

  useEffect(() => {
    const node = scrollRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [view?.messages.length])

  const sendMain = useCallback(async (): Promise<void> => {
    const text = draft.trim()
    if (!text) return
    setBusy(true)
    setError(null)
    try {
      const { messageId, createdAt } = await api.sendProjectMessage(workspace, projectId, text)
      // 发送成功的判据是信封落盘。先在本地画出来，流里那条会按 messageId 去重。
      setView(current => (current
        ? mergeMessage(current, {
          messageId,
          projectId,
          sender: { kind: 'user', id: 'user' },
          recipients: [{ kind: 'agent', id: current.coordinatorId }],
          placement: { kind: 'main' },
          kind: 'user-message',
          text,
          refs: [],
          createdAt,
        })
        : current))
      setDraft('')
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }, [draft, workspace, projectId])

  const sendThread = useCallback(async (): Promise<void> => {
    const text = threadDraft.trim()
    if (!text || !threadId) return
    setBusy(true)
    setError(null)
    try {
      await api.sendThreadMessage(workspace, projectId, threadId, text)
      setThreadDraft('')
      await loadThread(threadId, true)
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }, [threadDraft, threadId, workspace, projectId, loadThread])

  const refreshSnapshot = useCallback(async (): Promise<void> => {
    const snapshot = await api.getProject(workspace, projectId)
    if (selection.current === projectId) setView(fromSnapshot(snapshot))
  }, [workspace, projectId])

  const thread = threadId ? view?.threads.find(entry => entry.id === threadId) : undefined
  const tasks = (view?.threads ?? []).filter(entry => entry.depth > 0)
  const waiting = tasks.filter(entry => entry.state === 'waiting' || entry.state === 'blocked')
  const context = thread ? `${thread.permission} · ${folderName(workspace)}` : folderName(workspace)
  const config = {
    models: props.models,
    ...(props.model !== undefined ? { model: props.model } : {}),
    onModel: props.onModel,
    reasoningEffort: props.reasoningEffort,
    onReasoningEffort: props.onReasoningEffort,
  }

  return (
    <div className="chat">
      <div className="chat-content">
        <div className="chat-header">
          <div className="chat-title-line">
            <div className="chat-title ellipsis" title={workspace}>
              {view?.project.name ?? 'Project'}
            </div>
            <span className="agent-badge general">project</span>
          </div>
          <div className="chat-meta">
            <span className="ellipsis" title={workspace}>{workspace}</span>
            {view?.project.goal && <span className="ellipsis">{view.project.goal}</span>}
          </div>
          <div className="chat-header-actions">
            {!!waiting.length && <Badge color="amber">{waiting.length} waiting on you</Badge>}
            {(['overview', 'library', 'memory'] as const).map(entry => (
              <button
                key={entry}
                type="button"
                aria-pressed={!threadId && panel === entry}
                onClick={() => {
                  setThreadId(null)
                  setPanel(current => (current === entry ? null : entry))
                }}
              >
                {entry}
              </button>
            ))}
          </div>
        </div>

        <div className="messages-viewport">
          <div className="conversation-scroll" ref={scrollRef}>
            <div className="messages">
              {view?.messages.map(envelope => (
                <ProjectMessage
                  key={envelope.messageId}
                  envelope={envelope}
                  thread={envelope.threadId
                    ? view.threads.find(entry => entry.id === envelope.threadId)
                    : undefined}
                  steps={envelope.threadId ? plans.get(envelope.threadId) ?? [] : []}
                  replies={envelope.threadId
                    ? threadReplies(view.messages, envelope.threadId).length
                    : 0}
                  onOpenThread={id => setThreadId(id)}
                />
              ))}
              {view && !view.messages.length && (
                <div className="conversation-welcome">
                  <ListTodo size={28} strokeWidth={1.4} />
                  <h2>What should this project work on?</h2>
                  <p>Ask something small, or describe work worth its own thread.</p>
                </div>
              )}
              {!view && (
                <div className="conversation-welcome">
                  <h2>{error ? 'Could not open this project' : 'Loading…'}</h2>
                  {error && <p>{error}</p>}
                </div>
              )}
            </div>
          </div>
        </div>

        <Composer
          value={draft}
          onChange={setDraft}
          onSubmit={() => void sendMain()}
          placeholder="Ask for something, or add to the work in flight."
          disabled={!view}
          busy={busy}
          context={context}
          {...config}
        />

        <div className="conversation-footer">
          <button
            type="button"
            className={`subagent-toggle${threadId ? ' active' : ''}`}
            aria-expanded={threadId !== null}
            disabled={!tasks.length}
            onClick={() => setThreadId(current => (current ? null : tasks[0]?.id ?? null))}
          >
            <ListTodo size={14} aria-hidden="true" />
            {tasks.filter(entry => entry.state === 'working').length} active task
            {tasks.length > 0 && <span className="subagent-total">· {tasks.length} total</span>}
          </button>
        </div>
      </div>

      {threadId ? (
        <ThreadPanel
          {...(thread ? { thread } : {})}
          steps={plans.get(threadId) ?? []}
          events={details.get(threadId) ?? []}
          loading={loadingThread === threadId}
          onClose={() => setThreadId(null)}
          composer={{
            value: threadDraft,
            onChange: setThreadDraft,
            onSubmit: () => void sendThread(),
            placeholder: 'Tell this thread something, or ask where it is.',
            busy,
            context,
            ...config,
          }}
        />
      ) : (
        view && panel && (
          <aside className="project-panel" aria-label={panel}>
            {panel === 'overview' && (
              <OverviewPanel view={view} onOpenThread={id => setThreadId(id)} />
            )}
            {panel === 'library' && <LibraryPanel view={view} />}
            {panel === 'memory' && (
              <MemoryPanel
                workspace={workspace}
                projectId={projectId}
                view={view}
                onChanged={() => void refreshSnapshot()}
              />
            )}
          </aside>
        )
      )}
    </div>
  )
}

/** 主对话里的一条：普通发言用会话屏的消息渲染，派工是一张线程卡片。 */
function ProjectMessage({
  envelope,
  thread,
  steps,
  replies,
  onOpenThread,
}: {
  envelope: BootEnvelope
  thread?: ThreadRecord
  steps: readonly PlanStep[]
  replies: number
  onOpenThread: (id: string) => void
}) {
  if (envelope.kind === 'dispatch') {
    const target = thread?.id ?? envelope.threadId ?? ''
    return (
      <div className="thread-card" data-state={thread?.state ?? 'idle'}>
        <div className="thread-card-head">
          <span className="thread-card-title">{thread?.label ?? 'Thread'}</span>
          <span className="thread-card-state">
            {thread ? threadStateLabel(thread.state) : 'starting'}
          </span>
        </div>
        <p className="thread-card-goal">{thread?.goal ?? envelope.text}</p>
        {!!steps.length && (
          <ol className="steps">
            {steps.slice(0, 6).map(step => (
              <li key={step.id} data-mark={step.mark} title={step.detail}>
                <span className="step-mark" aria-hidden="true">{markOf(step.mark)}</span>
                <span className="step-title">{step.title}</span>
              </li>
            ))}
          </ol>
        )}
        <button
          type="button"
          className="thread-card-open"
          disabled={!target}
          onClick={() => onOpenThread(target)}
        >
          {replies === 1 ? '1 reply' : `${replies} replies`}
        </button>
      </div>
    )
  }

  if (envelope.kind === 'notice') {
    return (
      <div className="message system">
        <div className="message-body">{envelope.text}</div>
      </div>
    )
  }

  return (
    <MessageBlock
      message={{
        id: envelope.messageId,
        role: envelope.sender.kind === 'user' ? 'user' : 'assistant',
        content: envelope.text,
      }}
      assistantLabel={thread?.label ?? 'Tnega'}
    />
  )
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
