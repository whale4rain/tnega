import { useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { TextArea } from '@astryxdesign/core/TextArea'
import { TextInput } from '@astryxdesign/core/TextInput'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import { Collapsible } from '@astryxdesign/core/Collapsible'
import { Heading } from '@astryxdesign/core/Heading'
import { Stack } from '@astryxdesign/core/Stack'
import { Text } from '@astryxdesign/core/Text'
import { BookOpen, FileText, Link2, Search } from 'lucide-react'
import * as api from './api'
import { threadBuckets, threadStateLabel, type ProjectView } from './state'
import type { FactRecord, ThreadRecord } from './types'

export function OverviewPanel({ view, onOpenThread }: { view: ProjectView; onOpenThread: (id: string) => void }) {
  const tasks = view.threads.filter(thread => thread.depth > 0)
  const buckets = threadBuckets(tasks)
  const groups: Array<{ title: string; threads: ThreadRecord[] }> = [
    { title: 'Waiting on you', threads: buckets.waiting },
    { title: 'Working', threads: buckets.working },
    { title: 'Idle', threads: buckets.idle },
    { title: 'Resolved', threads: buckets.finished },
  ]
  return <Stack className="project-knowledge thread-overview" gap={3} padding={3}>
    <Stack direction="horizontal" align="center" gap={2} paddingBlock={2}>
      <Text weight="semibold">Threads</Text><Text color="secondary" type="supporting">{tasks.length}</Text>
    </Stack>
    {!tasks.length && <Text color="secondary">No threads yet.</Text>}
    {groups.filter(group => group.threads.length).map(group => <Collapsible key={group.title} defaultIsOpen={group.title !== 'Resolved'} trigger={<Text type="supporting" color="secondary">{group.title} · {group.threads.length}</Text>} chevronPosition="start">
      <Stack gap={0}>
        {group.threads.map(thread => <Button key={thread.id} className="project-thread-row" variant="ghost" label={`Open thread: ${thread.label}`} icon={<StatusDot variant={thread.state === 'working' ? 'accent' : thread.state === 'done' ? 'success' : thread.state === 'failed' ? 'error' : thread.state === 'blocked' || thread.state === 'waiting' ? 'warning' : 'neutral'} isPulsing={thread.state === 'working'} label={threadStateLabel(thread.state)} tooltip={threadStateLabel(thread.state)} />} onClick={() => onOpenThread(thread.id)}>
          <Text maxLines={1}>{thread.label}</Text>
        </Button>)}
      </Stack>
    </Collapsible>)}
  </Stack>
}

export function LibraryPanel({ view }: { view: ProjectView }) {
  const [query, setQuery] = useState('')
  const matches = (fact: FactRecord) => `${fact.data.title ?? ''} ${fact.data.uri ?? ''} ${fact.id}`.toLowerCase().includes(query.toLowerCase())
  const groups = [
    { title: 'Created by agents', facts: view.artifacts.filter(matches), icon: FileText },
    { title: 'Reference material', facts: view.resources.filter(matches), icon: Link2 },
  ]
  return <Stack className="project-knowledge" padding={3} gap={3}>
    <Text weight="semibold">Library</Text>
    <TextInput label="Search library" isLabelHidden placeholder="Find a file or resource…" startIcon={<Search size={16} />} value={query} onChange={setQuery} />
    {groups.map(group => <Stack as="section" key={group.title} gap={3}>
      <Stack direction="horizontal" align="center" justify="between" className="project-library-heading">
        <Heading level={3}>{group.title}</Heading>
        <Text type="supporting" color="secondary">{group.facts.length}</Text>
      </Stack>
      {!group.facts.length && <Text color="secondary">{query ? 'No matching items.' : 'No items yet.'}</Text>}
      {group.facts.map(fact => <Stack as="article" key={fact.id} className="project-library-row" direction="horizontal" gap={3} paddingBlock={3}>
        <group.icon size={17} aria-hidden="true" />
        <Stack gap={1} className="min-w-0">
          <Text weight="medium" maxLines={1}>{String(fact.data.title ?? fact.id)}</Text>
          <Text className="project-library-location" type="supporting" color="secondary" maxLines={1}>
            {group.title === 'Created by agents' ? `${String(fact.data.mediaType ?? 'File')} · ${formatBytes(Number(fact.data.size ?? 0))} · ` : ''}
            {String(fact.data.uri ?? fact.id)}
          </Text>
        </Stack>
      </Stack>)}
    </Stack>)}
  </Stack>
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
  const [history, setHistory] = useState<{ id: string; versions: FactRecord[] } | null>(null)
  const [saving, setSaving] = useState(false)

  async function beginEdit(fact: FactRecord): Promise<void> {
    setAdding(false)
    setEditing(fact.id)
    setDraft(String(fact.data.text ?? ''))
    setError(null)
    setHistory(null)
    try {
      const { history: versions } = await api.memoryHistory(workspace, projectId, fact.id)
      setHistory({ id: fact.id, versions })
    } catch {
      setHistory(null)
    }
  }

  async function save(fact: FactRecord | null): Promise<void> {
    const text = draft.trim()
    if (!text || saving) return
    setSaving(true)
    setError(null)
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
    } finally {
      setSaving(false)
    }
  }

  async function remove(fact: FactRecord): Promise<void> {
    if (saving) return
    setSaving(true)
    setError(null)
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
    } finally {
      setSaving(false)
    }
  }

  return (
    <Stack className="project-knowledge" gap={3} padding={3}>
      <Text weight="semibold">Memory</Text>
      {error && <div className="project-panel-error" role="alert">{error}</div>}
      {adding ? (
        <Stack gap={3}>
          <TextArea label="Memory entry" isLabelHidden value={draft} placeholder="A durable fact about this project." onChange={setDraft} />
          <Stack direction="horizontal" gap={2} wrap="wrap">
            <Button label="Save" size="sm" onClick={() => void save(null)} isDisabled={!draft.trim() || saving} />
            <Button label="Cancel" size="sm" variant="secondary" onClick={() => { setAdding(false); setDraft('') }} />
          </Stack>
        </Stack>
      ) : (
        <Button
          label="Add memory"
          size="sm"
          variant="secondary"
          icon={<BookOpen size={14} aria-hidden="true" />}
          onClick={() => { setEditing(null); setAdding(true); setDraft(''); setHistory(null) }}
        />
      )}
      {!view.memory.length && !adding && (
        <p className="project-panel-hint">
          Nothing remembered yet. Threads write here as they learn durable facts; you can edit or
          delete any entry, and every change keeps the one it replaced.
        </p>
      )}
      {view.memory.map(fact => (
        <Collapsible key={fact.id} className="memory-row" defaultIsOpen={false} trigger={<Text maxLines={1}>{memorySummary(String(fact.data.text ?? ''))}</Text>}>

          {editing === fact.id ? (
            <Stack gap={3}>
              <TextArea label="Memory entry" isLabelHidden value={draft} onChange={setDraft} />
              <Stack direction="horizontal" gap={2} wrap="wrap">
                <Button label="Save" size="sm" onClick={() => void save(fact)} isDisabled={!draft.trim() || saving} />
                <Button label="Cancel" size="sm" variant="secondary" onClick={() => setEditing(null)} />
                <Button label="Delete" size="sm" variant="destructive" isDisabled={saving} onClick={() => void remove(fact)} />
              </Stack>
            </Stack>
          ) : (
            <>
              <p className="memory-text">{String(fact.data.text ?? '')}</p>
              <p className="memory-meta">
                v{fact.version} · {fact.author}
                <Button label="Edit memory" variant="ghost" size="sm" isDisabled={saving} onClick={() => void beginEdit(fact)} />
              </p>
              {history?.id === fact.id && history.versions.length > 1 && (
                <details className="memory-history">
                  <summary>{history.versions.length} versions</summary>
                  <ol>
                    {history.versions.map(version => (
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
        </Collapsible>
      ))}
    </Stack>
  )
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function memorySummary(value: string): string {
  const summary = value.replace(/\s+/g, ' ').trim()
  return summary.length > 76 ? `${summary.slice(0, 76).trimEnd()}…` : summary
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
