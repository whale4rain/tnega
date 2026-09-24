import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { X } from 'lucide-react'
import * as api from '../api'
import type { SessionEvent, SubagentEntry } from '../types'
import { projectEvents } from '../projectEvents'
import { groupToolMessages } from '../toolGroups'
import { MessageBlock, ToolGroupBlock } from './Transcript'

const WIDTH_KEY = 'tnega-subagent-sidebar-width'

interface Props {
  workspace: string
  subagents: SubagentEntry[]
  selectedId: string | null
  onSelect: (id: string) => void
  onClose: () => void
}

export function SubagentSidebar({ workspace, subagents, selectedId, onSelect, onClose }: Props) {
  const [events, setEvents] = useState<SessionEvent[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [width, setWidth] = useState(() => {
    const stored = Number(localStorage.getItem(WIDTH_KEY))
    const max = Math.max(260, Math.min(720, window.innerWidth - 380))
    return Math.max(260, Math.min(max, Number.isFinite(stored) && stored >= 260 ? stored : 340))
  })
  const dragging = useRef(false)
  const asideRef = useRef<HTMLElement | null>(null)
  const loaded = useRef<{ id: string; seq: number } | null>(null)
  const selected = subagents.find(child => child.id === selectedId)
    ?? subagents.find(child => child.status === 'running')
    ?? subagents[0]
  const activeCount = subagents.filter(child => child.status === 'running').length
  const items = useMemo(() => groupToolMessages(projectEvents(events ?? [])), [events])

  function handleResizeMove(event: PointerEvent<HTMLDivElement>): void {
    if (!dragging.current) return
    const right = asideRef.current?.getBoundingClientRect().right
    if (right === undefined) return
    const max = Math.max(260, Math.min(720, window.innerWidth - 380))
    setWidth(Math.max(260, Math.min(max, right - event.clientX)))
  }

  function stopResize(event: PointerEvent<HTMLDivElement>): void {
    if (!dragging.current) return
    dragging.current = false
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    localStorage.setItem(WIDTH_KEY, String(width))
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  useEffect(() => {
    if (!selected) {
      setEvents(null)
      loaded.current = null
      return
    }
    let cancelled = false
    let pending = false
    const refresh = () => {
      if (pending) return
      pending = true
      void api.getSubagent(workspace, selected.id)
        .then(result => {
          if (!cancelled) {
            const seq = result.events.at(-1)?.seq ?? 0
            if (loaded.current?.id !== selected.id || loaded.current.seq !== seq) {
              loaded.current = { id: selected.id, seq }
              setEvents(result.events)
            }
            setError(null)
          }
        })
        .catch(reason => {
          if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
        })
        .finally(() => { pending = false })
    }
    setEvents(null)
    loaded.current = null
    setError(null)
    refresh()
    const timer = selected.status === 'running' ? window.setInterval(refresh, 2_000) : undefined
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearInterval(timer)
    }
  }, [workspace, selected?.id, selected?.status])

  return (
    <aside
      ref={asideRef}
      id="subagent-sidebar"
      className="subagent-sidebar"
      aria-label="Subagent tasks"
      style={{ flexBasis: width }}
    >
      <div
        className="subagent-resize-handle"
        role="separator"
        aria-label="Resize tasks sidebar"
        aria-orientation="vertical"
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={event => {
          dragging.current = true
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={handleResizeMove}
        onPointerUp={stopResize}
        onPointerCancel={stopResize}
        onKeyDown={event => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          const next = Math.max(260, Math.min(720, width + (event.key === 'ArrowLeft' ? 24 : -24)))
          setWidth(next)
          localStorage.setItem(WIDTH_KEY, String(next))
        }}
      />
      <div className="subagent-sidebar-heading">
        <div>
          <strong>Tasks</strong>
          <span>{activeCount} active · {subagents.length} total</span>
        </div>
        <button type="button" className="icon-button" aria-label="Close tasks sidebar" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <div className="subagent-list" aria-label="Subagent task list">
        {subagents.map(child => (
          <button
            key={child.id}
            type="button"
            className={`subagent-list-item${selected?.id === child.id ? ' selected' : ''}`}
            aria-current={selected?.id === child.id ? 'true' : undefined}
            onClick={() => onSelect(child.id)}
            style={{ paddingLeft: `${12 + Math.min(child.depth, 4) * 12}px` }}
          >
            <span className={`subagent-status-dot ${child.status}`} aria-hidden="true" />
            <span className="subagent-list-copy">
              <span className="subagent-list-label">{child.label}</span>
              <span className="subagent-list-meta">{child.mode} · {child.status}</span>
            </span>
          </button>
        ))}
      </div>
      {selected && (
        <section className="subagent-inspector" aria-label={`${selected.label} activity`}>
          <div className="subagent-inspector-heading">
            <strong title={selected.id}>{selected.label}</strong>
            <span className={`subagent-status ${selected.status}`}>{selected.status}</span>
          </div>
          <div className="subagent-inspector-meta">{selected.mode} · level {selected.depth}</div>
          {error && <p className="subagent-inspector-error" role="alert">{error}</p>}
          {!events && !error && <p className="subagent-inspector-empty">Loading activity…</p>}
          {events && items.length === 0 && <p className="subagent-inspector-empty">No activity yet.</p>}
          <div className="subagent-transcript">
            {items.map(item => item.kind === 'tools'
              ? <ToolGroupBlock key={`tools-${item.tools[0]?.id ?? 'empty'}`} tools={item.tools} />
              : <MessageBlock key={item.message.id} message={item.message} assistantLabel={selected.label} />)}
          </div>
          {items.length === 0 && selected.lastOutput && (
            <p className="subagent-inspector-empty">{selected.lastOutput}</p>
          )}
        </section>
      )}
    </aside>
  )
}
