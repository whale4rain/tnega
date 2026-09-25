import { useState } from 'react'
import { Button, TextArea } from '@radix-ui/themes'
import { BookOpen, FileText, Link2 } from 'lucide-react'
import * as api from './api'
import { threadBuckets, threadStateLabel, type ProjectView } from './state'
import type { FactRecord, ThreadRecord } from './types'

export function OverviewPanel({
  view,
  onOpenThread,
}: {
  view: ProjectView
  onOpenThread: (threadId: string) => void
}) {
  const buckets = threadBuckets(view.threads)
  const groups: Array<{ title: string; threads: ThreadRecord[] }> = [
    { title: 'Waiting on you', threads: buckets.waiting },
    { title: 'Working', threads: buckets.working },
    { title: 'Idle', threads: buckets.idle },
    { title: 'Finished', threads: buckets.finished },
  ]
  if (!groups.some(group => group.threads.length)) {
    return (
      <div className="project-panel-empty">
        <p>No threads yet.</p>
        <p className="project-panel-hint">
          The coordinator opens a thread when a piece of work deserves its own context.
        </p>
      </div>
    )
  }
  return (
    <div className="overview">
      {groups.filter(group => group.threads.length).map(group => (
        <section key={group.title}>
          <h3>
            {group.title}
            <span className="overview-count">{group.threads.length}</span>
          </h3>
          {group.threads.map(thread => (
            <button
              key={thread.id}
              type="button"
              className="overview-row"
              data-state={thread.state}
              onClick={() => onOpenThread(thread.id)}
            >
              <span className="overview-row-label">{thread.label}</span>
              <span className="overview-row-state">{threadStateLabel(thread.state)}</span>
            </button>
          ))}
        </section>
      ))}
    </div>
  )
}

export function LibraryPanel({ view }: { view: ProjectView }) {
  const empty = !view.artifacts.length && !view.resources.length
  if (empty) {
    return (
      <div className="project-panel-empty">
        <p>The library is empty.</p>
        <p className="project-panel-hint">
          Artifacts published by threads and indexed resources show up here, with their source.
        </p>
      </div>
    )
  }
  return (
    <div className="library">
      {view.artifacts.map(fact => (
        <article key={fact.id} className="library-row">
          <FileText size={15} aria-hidden="true" />
          <div>
            <p className="library-title">{String(fact.data.title ?? fact.id)}</p>
            <p className="library-meta">
              artifact · {String(fact.data.mediaType ?? 'text/plain')} · {formatBytes(Number(fact.data.size ?? 0))}
            </p>
            <p className="library-ref">{fact.id}</p>
          </div>
        </article>
      ))}
      {view.resources.map(fact => (
        <article key={fact.id} className="library-row">
          <Link2 size={15} aria-hidden="true" />
          <div>
            <p className="library-title">{String(fact.data.title ?? fact.id)}</p>
            <p className="library-meta">resource</p>
            <p className="library-ref">{String(fact.data.uri ?? '')}</p>
          </div>
        </article>
      ))}
    </div>
  )
}

export function MemoryPanel({
  workspace,
  projectId,
  view,
  onChanged,
}: {
  workspace: string
  projectId: string
  view: ProjectView
  onChanged: () => void
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<Array<FactRecord>>([])

  async function beginEdit(fact: FactRecord): Promise<void> {
    setEditing(fact.id)
    setDraft(String(fact.data.text ?? ''))
    setError(null)
    try {
      const { history: versions } = await api.memoryHistory(workspace, projectId, fact.id)
      setHistory(versions)
    } catch {
      setHistory([])
    }
  }

  async function save(fact: FactRecord | null): Promise<void> {
    const text = draft.trim()
    if (!text) return
    try {
      if (fact) {
        await api.updateMemory(workspace, projectId, fact.id, {
          text,
          expectedVersion: fact.version,
        })
      } else {
        await api.addMemory(workspace, projectId, { text })
      }
      setEditing(null)
      setAdding(false)
      setDraft('')
      onChanged()
    } catch (reason) {
      setError(messageOf(reason))
      onChanged()
    }
  }

  async function remove(fact: FactRecord): Promise<void> {
    try {
      await api.updateMemory(workspace, projectId, fact.id, {
        text: String(fact.data.text ?? ''),
        expectedVersion: fact.version,
        deleted: true,
      })
      setEditing(null)
      onChanged()
    } catch (reason) {
      setError(messageOf(reason))
      onChanged()
    }
  }

  return (
    <div className="memory">
      {error && <div className="project-panel-error" role="alert">{error}</div>}
      {adding ? (
        <div className="memory-editor">
          <TextArea value={draft} placeholder="A durable fact about this project." onChange={event => setDraft(event.target.value)} />
          <div className="memory-actions">
            <Button size="1" onClick={() => void save(null)} disabled={!draft.trim()}>Save</Button>
            <Button size="1" variant="soft" onClick={() => { setAdding(false); setDraft('') }}>Cancel</Button>
          </div>
        </div>
      ) : (
        <Button size="1" variant="soft" onClick={() => { setAdding(true); setDraft('') }}>
          <BookOpen size={14} aria-hidden="true" />
          Add memory
        </Button>
      )}
      {!view.memory.length && !adding && (
        <p className="project-panel-hint">
          Nothing remembered yet. Threads write here as they learn durable facts; you can edit or
          delete any entry, and every change keeps the one it replaced.
        </p>
      )}
      {view.memory.map(fact => (
        <article key={fact.id} className="memory-row" data-editing={editing === fact.id}>
          {editing === fact.id ? (
            <div className="memory-editor">
              <TextArea value={draft} onChange={event => setDraft(event.target.value)} />
              <div className="memory-actions">
                <Button size="1" onClick={() => void save(fact)} disabled={!draft.trim()}>Save</Button>
                <Button size="1" variant="soft" onClick={() => setEditing(null)}>Cancel</Button>
                <Button size="1" color="red" variant="soft" onClick={() => void remove(fact)}>Delete</Button>
              </div>
            </div>
          ) : (
            <>
              <p className="memory-text">{String(fact.data.text ?? '')}</p>
              <p className="memory-meta">
                v{fact.version} · {fact.author}
                <button type="button" onClick={() => void beginEdit(fact)}>Edit</button>
              </p>
              {!!history.length && history.length > 1 && (
                <details className="memory-history">
                  <summary>{history.length} versions</summary>
                  <ol>
                    {history.map(version => (
                      <li key={`${version.version}`}>
                        <span>v{version.version} · {version.author}</span>
                        <span>{version.deleted ? '(deleted)' : String(version.data.text ?? '')}</span>
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </>
          )}
        </article>
      ))}
    </div>
  )
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
