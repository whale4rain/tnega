import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { Stack } from '@astryxdesign/core/Stack'
import { Button } from '@astryxdesign/core/Button'
import { TextArea } from '@astryxdesign/core/TextArea'
import { Text } from '@astryxdesign/core/Text'
import { PlanPanel } from '../PlanPanel'
import type { DisplayPlan } from '../planDisplay'
import { IconButton } from '@astryxdesign/core/IconButton'
import { ChevronRight, X } from 'lucide-react'
import { MessageBlock, projectEvents, type DisplayMessage } from './reuse'
import { groupToolMessages } from '../toolGroups'
import { ToolGroupBlock } from '../conversation/Transcript'
import { threadStateLabel } from './state'
import type { SessionEvent, ThreadRecord } from './types'

export interface ThreadPanelProps {
  thread?: ThreadRecord
  events: readonly SessionEvent[]
  loading: boolean
  /** 这个 Thread 正在生成的正文；整轮结束后由它自己的回复取代。 */
  draft?: string
  onClose: () => void
  onSend: (text: string) => Promise<void>
  /** Execution plan for this thread. */
  plan?: DisplayPlan | undefined
}

/**
 * 右侧的 Thread 栏，形状与 `SubagentSidebar` 一致（同样的宽度、分割线与出现动画）。
 *
 * 内容是投影出来的：上下文读 Thread 记录，正文读该 Agent 自己的 Session —— 主对话只由
 * 协调者发言，子 Thread 的详细输出留在它这里。
 */
export function ThreadPanel(props: ThreadPanelProps) {
  const transcript = useMemo(() => projectEvents([...props.events]), [props.events])
  const items = useMemo(() => groupToolMessages(transcript), [transcript])
  const { thread } = props
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')
  async function send() {
    const text = message.trim()
    if (!text || sending) return
    setSending(true)
    setSendError('')
    try { await props.onSend(text); setMessage('') }
    catch (error) { setSendError(error instanceof Error ? error.message : String(error)) }
    finally { setSending(false) }
  }
  const [width, setWidth] = useState(() => {
    const stored = Number(localStorage.getItem('tnega-thread-sidebar-width'))
    const max = Math.max(260, Math.min(720, window.innerWidth - 380))
    return Math.max(260, Math.min(max, Number.isFinite(stored) && stored >= 260 ? stored : 340))
  })
  const dragging = useRef(false)
  const panelRef = useRef<HTMLElement>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const node = transcriptRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [thread?.id, props.events.length, props.draft])

  function resize(event: PointerEvent<HTMLDivElement>) {
    if (!dragging.current) return
    const right = panelRef.current?.getBoundingClientRect().right
    if (right === undefined) return
    const max = Math.max(260, Math.min(720, window.innerWidth - 380))
    setWidth(Math.max(260, Math.min(max, right - event.clientX)))
  }

  function stopResize(event: PointerEvent<HTMLDivElement>) {
    if (!dragging.current) return
    dragging.current = false
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    localStorage.setItem('tnega-thread-sidebar-width', String(width))
  }

  return (
    <aside ref={panelRef} className="thread-panel" aria-label="Thread" style={{ flexBasis: width }}>
      <div className="thread-resize-handle" role="separator" aria-label="Resize thread sidebar"
        aria-orientation="vertical" aria-valuenow={width} tabIndex={0}
        onPointerDown={event => { dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId) }}
        onPointerMove={resize} onPointerUp={stopResize} onPointerCancel={stopResize}
        onKeyDown={event => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          const next = Math.max(260, Math.min(720, width + (event.key === 'ArrowLeft' ? 24 : -24)))
          setWidth(next)
          localStorage.setItem('tnega-thread-sidebar-width', String(next))
        }} />
      <header className="thread-panel-head">
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <span>Threads</span>
          <ChevronRight size={12} aria-hidden="true" />
          <span className="breadcrumb-current">{thread?.label ?? 'Thread'}</span>
        </nav>
        <IconButton
          label="Close thread"
          icon={<X size={15} aria-hidden="true" />}
          variant="ghost"
          size="sm"
          onClick={props.onClose}
        />
      </header>

      <div className="thread-panel-scroll" ref={transcriptRef}>
        <section className="panel-card context-card">
          <div className="context-row">
            <span className="context-label">State</span>
            <span className="context-value">
              {thread ? threadStateLabel(thread.state) : 'loading'}
            </span>
          </div>
          <div className="context-row">
            <span className="context-label">Goal</span>
            <span className="context-value">{thread?.goal ?? '—'}</span>
          </div>
          {thread?.expect && (
            <div className="context-row">
              <span className="context-label">Expects</span>
              <span className="context-value">{thread.expect}</span>
            </div>
          )}
          {thread?.detail && (
            <div className="context-row">
              <span className="context-label">Latest</span>
              <span className="context-value">{thread.detail}</span>
            </div>
          )}
        </section>

        <PlanPanel plan={props.plan} />
        <section className="thread-transcript">
          {props.loading && !transcript.length && <p className="panel-empty">Loading…</p>}
          {!props.loading && !transcript.length && (
            <p className="panel-empty">Nothing yet — this thread has not run.</p>
          )}
          {items.map(item => item.kind === 'tools'
            ? <ToolGroupBlock key={`tools-${item.tools[0]?.id ?? 'empty'}`} tools={item.tools} />
            : <TranscriptRow key={item.message.id} message={item.message} label={thread?.label} />
          )}
          {props.draft !== undefined && (
            <MessageBlock
              message={{ id: 'draft', role: 'assistant', content: props.draft, pending: true }}
              assistantLabel={thread?.label ?? 'Tnega'}
            />
          )}
        </section>

      </div>
      <Stack as="form" padding={3} gap={2} className="thread-input" onSubmit={event => { event.preventDefault(); void send() }}>
        <TextArea label="Message thread" isLabelHidden placeholder="Reply to this thread…" value={message} onChange={setMessage} isDisabled={sending} />
        <Stack direction="horizontal" justify="end"><Button label="Send to thread" size="sm" type="submit" isDisabled={sending || !message.trim()} /></Stack>
        {sendError && <Text role="alert" color="secondary">{sendError}</Text>}
      </Stack>
    </aside>
  )
}

/** 正文与会话屏同源（`MessageBlock`）；工具调用在窄栏里收成一行，展开才看输出。 */
function TranscriptRow({ message, label }: { message: DisplayMessage; label?: string | undefined }) {
  if (message.role === 'tool') {
    const tool = message.tool
    return (
      <details className="tool-row" data-ok={tool?.ok}>
        <summary>
          <span className="tool-name">{tool?.name ?? 'tool'}</span>
          <span className="tool-state">
            {tool?.status === 'pending' ? 'running' : tool?.ok === false ? 'failed' : 'done'}
          </span>
        </summary>
        <pre className="tool-row-output">{tool?.outputText || tool?.errorText || tool?.argumentsText}</pre>
      </details>
    )
  }
  if (message.role === 'system' || message.role === 'file-edits') return null
  return <MessageBlock message={message} assistantLabel={label ?? 'Tnega'} />
}
