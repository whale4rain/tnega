import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, TextArea } from '@radix-ui/themes'
import { Loader2, Send, X } from 'lucide-react'
import * as api from './api'
import { MessageBlock, PlanPanel, latestPlanFromEvents, projectEvents } from './reuse'
import { threadStateLabel } from './state'
import type { ThreadDetail, ThreadRecord, ThreadState } from './types'

const POLL_MS = 1_500

/**
 * 侧边的 Thread 面板：这个 Agent 自己的 Session、步骤、输入与产物。
 *
 * 它读的是**该 Agent 的 Session 事件**，不是主对话：主对话只由协调者发言，子 Thread 的
 * 详细输出留在它自己这里。用户在这里的留言进它的 inbox，回复也留在它的面板上。
 */
export function ThreadPanel({
  workspace,
  projectId,
  threadId,
  state,
  onClose,
  onThread,
}: {
  workspace: string
  projectId: string
  threadId: string
  /** 该 Thread 的当前状态，来自主对话那条流；卡片与这里始终是同一个事实。 */
  state: ThreadState
  onClose: () => void
  onThread: (thread: ThreadRecord) => void
}) {
  const [detail, setDetail] = useState<ThreadDetail | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const wanted = useRef(threadId)
  wanted.current = threadId

  const refresh = useCallback(async () => {
    const next = await api.getThread(workspace, projectId, threadId)
    if (wanted.current !== threadId) return next
    setDetail(next)
    onThread(next.thread)
    return next
  }, [workspace, projectId, threadId, onThread])

  useEffect(() => {
    setDetail(null)
    void refresh().catch((reason: unknown) => {
      if (wanted.current === threadId) setError(messageOf(reason))
    })
  }, [refresh, threadId])

  // 正在跑的 Thread 自己会写 Session；在它停下来之前按固定间隔补齐。
  useEffect(() => {
    if (state !== 'working') return
    const timer = setInterval(() => {
      void refresh().catch(() => undefined)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [state, refresh])

  const messages = useMemo(() => projectEvents(detail?.events ?? []), [detail])
  const plan = useMemo(() => latestPlanFromEvents(detail?.events ?? []), [detail])

  useEffect(() => {
    const node = scroller.current
    if (node) node.scrollTop = node.scrollHeight
  }, [messages.length])

  async function send() {
    const text = draft.trim()
    if (!text) return
    setBusy(true)
    setError(null)
    try {
      await api.sendThreadMessage(workspace, projectId, threadId, text)
      setDraft('')
      await refresh()
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }

  const thread = detail?.thread
  return (
    <aside className="thread-panel" aria-label="Thread">
      <header className="thread-panel-header">
        <div className="thread-panel-title">
          <span className="thread-panel-name">{thread?.label ?? 'Thread'}</span>
          <span className="thread-panel-state" data-state={state}>
            {threadStateLabel(state)}
            {state === 'working' && <Loader2 size={12} className="spin" aria-hidden="true" />}
          </span>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close thread">
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <p className="thread-panel-goal">{thread?.goal}</p>
      <p className="thread-panel-meta">
        {thread?.permission ?? 'read-only'} · depth {thread?.depth ?? 0} · {threadId}
      </p>
      {thread?.detail && <p className="thread-panel-detail">{thread.detail}</p>}
      {error && <div className="thread-panel-error" role="alert">{error}</div>}
      <div className="thread-panel-scroll" ref={scroller}>
        <PlanPanel plan={plan} />
        {messages.map(message => (
          <MessageBlock key={message.id} message={message} assistantLabel={thread?.label ?? 'Thread'} />
        ))}
        {!messages.length && <p className="thread-panel-empty">Nothing yet — this thread has not run.</p>}
      </div>
      <div className="thread-panel-composer">
        <TextArea
          value={draft}
          placeholder="Tell this thread something, or ask where it is."
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void send()
            }
          }}
        />
        <Button onClick={() => void send()} disabled={busy || !draft.trim()}>
          <Send size={14} aria-hidden="true" />
          Send
        </Button>
      </div>
    </aside>
  )
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
