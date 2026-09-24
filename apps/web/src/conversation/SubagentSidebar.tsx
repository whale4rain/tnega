import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import * as api from '../api'
import type { SessionEvent, SubagentEntry } from '../types'

interface Props {
  workspace: string
  subagents: SubagentEntry[]
  onClose: () => void
}

export function SubagentSidebar({ workspace, subagents, onClose }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [events, setEvents] = useState<SessionEvent[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const selected = subagents.find(child => child.id === selectedId)
    ?? subagents.find(child => child.status === 'running')
    ?? subagents[0]
  const activeCount = subagents.filter(child => child.status === 'running').length

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
      return
    }
    let cancelled = false
    const refresh = () => {
      void api.getSubagent(workspace, selected.id)
        .then(result => {
          if (!cancelled) {
            setEvents(result.events)
            setError(null)
          }
        })
        .catch(reason => {
          if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
        })
    }
    setEvents(null)
    setError(null)
    refresh()
    const timer = selected.status === 'running' ? window.setInterval(refresh, 2_000) : undefined
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearInterval(timer)
    }
  }, [workspace, selected?.id, selected?.status])

  const transcript = events?.filter(event =>
    event.type === 'user/message' ||
    event.type === 'assistant/message' ||
    event.type === 'tool/call' ||
    event.type === 'tool/result',
  )

  return (
    <aside id="subagent-sidebar" className="subagent-sidebar" aria-label="Subagent tasks">
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
            onClick={() => setSelectedId(child.id)}
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
          {transcript?.length === 0 && <p className="subagent-inspector-empty">No activity yet.</p>}
          <div className="subagent-transcript">
            {transcript?.map(event => {
              const label = event.type === 'tool/call' ? `Tool · ${event.payload.name}`
                : event.type === 'tool/result' ? 'Tool result'
                  : event.type === 'user/message' ? 'Task' : 'Agent'
              const content = event.type === 'tool/call'
                ? JSON.stringify(event.payload.arguments)
                : event.type === 'tool/result'
                  ? event.payload.error?.message ?? JSON.stringify(event.payload.output ?? '')
                  : event.payload.content
              return (
                <div className="subagent-event" key={event.id}>
                  <span>{label}</span>
                  <p>{content}</p>
                </div>
              )
            })}
          </div>
          {!transcript?.length && selected.lastOutput && (
            <div className="subagent-event"><span>Last output</span><p>{selected.lastOutput}</p></div>
          )}
        </section>
      )}
    </aside>
  )
}
