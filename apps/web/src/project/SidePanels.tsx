import { useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { TextArea } from '@astryxdesign/core/TextArea'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Heading } from '@astryxdesign/core/Heading'
import { Stack } from '@astryxdesign/core/Stack'
import { Text } from '@astryxdesign/core/Text'
import { BookOpen, FileText, Link2, Search, ArrowUpRight } from 'lucide-react'
import * as api from './api'
import { threadBuckets, threadStateLabel, type ProjectView } from './state'
import type { FactRecord, ThreadRecord } from './types'

function PanelIntro({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <Stack gap={2}>
    <Text color="accent" type="supporting">{eyebrow}</Text>
    <Heading level={2}>{title}</Heading>
    <Text color="secondary">{description}</Text>
  </Stack>
}

export function OverviewPanel({ view, onOpenThread }: { view: ProjectView; onOpenThread: (id: string) => void }) {
  const tasks = view.threads.filter(thread => thread.depth > 0)
  const buckets = threadBuckets(tasks)
  const groups: Array<{ title: string; threads: ThreadRecord[] }> = [
    { title: 'Needs attention', threads: buckets.waiting },
    { title: 'In progress', threads: buckets.working },
    { title: 'Ready to continue', threads: buckets.idle },
    { title: 'Completed', threads: buckets.finished },
  ]
  return <Stack className="project-knowledge" gap={6} padding={6}>
    <PanelIntro eyebrow="PROJECT AT A GLANCE" title="Overview" description="One goal. A coordinated team of agents." />
    <Stack className="project-brief" padding={4} gap={2}>
      <Text weight="semibold">North star</Text>
      <Text color="secondary">{view.project.goal || 'Describe your goal in the main conversation to give this project direction.'}</Text>
    </Stack>
    <Stack direction="horizontal" gap={6}>
      <Stack gap={1}><Heading level={2}>{tasks.length}</Heading><Text color="secondary" type="supporting">Threads</Text></Stack>
      <Stack gap={1}><Heading level={2}>{view.artifacts.length + view.resources.length}</Heading><Text color="secondary" type="supporting">Library items</Text></Stack>
      <Stack gap={1}><Heading level={2}>{view.memory.length}</Heading><Text color="secondary" type="supporting">Memories</Text></Stack>
    </Stack>
    {!tasks.length && <Text color="secondary">Delegated work will appear here when the main agent opens a thread.</Text>}
    {groups.filter(group => group.threads.length).map(group => <Stack as="section" gap={3} key={group.title}>
      <Stack direction="horizontal" justify="between"><Text weight="semibold">{group.title}</Text><Text color="secondary">{group.threads.length}</Text></Stack>
      {group.threads.map(thread => <Button key={thread.id} className="project-thread-row" variant="ghost" label={`Open thread: ${thread.label}`} endContent={<ArrowUpRight size={16} aria-hidden="true" />} onClick={() => onOpenThread(thread.id)}>
        <Stack gap={1}>
          <Text weight="medium">{thread.label}</Text>
          <Text color="secondary" type="supporting" maxLines={2}>{thread.goal}</Text>
          <Text color="accent" type="supporting">{threadStateLabel(thread.state)}</Text>
        </Stack>
      </Button>)}
    </Stack>)}
  </Stack>
}

export function LibraryPanel({ view }: { view: ProjectView }) {
  const [query, setQuery] = useState('')
  const matches = (fact: FactRecord) => `${fact.data.title ?? ''} ${fact.data.uri ?? ''} ${fact.id}`.toLowerCase().includes(query.toLowerCase())
  const groups = [
    { title: 'Created by agents', description: 'Outputs from the work in this project', facts: view.artifacts.filter(matches), icon: FileText },
    { title: 'Reference material', description: 'Sources available to the project', facts: view.resources.filter(matches), icon: Link2 },
  ]
  return <Stack className="project-knowledge" padding={6} gap={6}>
    <PanelIntro eyebrow="SHARED KNOWLEDGE" title="Library" description="Everything the project draws from, and everything it creates." />
    <TextInput label="Search library" isLabelHidden placeholder="Find a file or resource…" startIcon={<Search size={16} />} value={query} onChange={setQuery} />
    {groups.map(group => <Stack as="section" key={group.title} gap={3}>
      <Stack gap={1}><Heading level={3}>{group.title}</Heading><Text type="supporting" color="secondary">{group.description}</Text></Stack>
      {!group.facts.length && <Text color="secondary">{query ? 'No matching items.' : 'No items yet.'}</Text>}
      {group.facts.map(fact => <Stack as="article" key={fact.id} className="project-library-row" direction="horizontal" gap={3} paddingBlock={4}>
        <group.icon size={20} aria-hidden="true" />
        <Stack gap={1} className="min-w-0">
          <Text weight="medium" maxLines={2}>{String(fact.data.title ?? fact.id)}</Text>
          <Text type="supporting" color="secondary">{group.title === 'Created by agents' ? `${String(fact.data.mediaType ?? 'File')} · ${formatBytes(Number(fact.data.size ?? 0))}` : 'Reference source'}</Text>
          <Text type="supporting" color="secondary" wordBreak="break-all">{String(fact.data.uri ?? fact.id)}</Text>
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
    <Stack className="project-knowledge" gap={6} padding={6}>
      <PanelIntro eyebrow="PROJECT CONTEXT" title="Memory" description="The decisions and facts that keep every thread aligned." />
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
        <article key={fact.id} className="memory-row" data-editing={editing === fact.id}>
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
        </article>
      ))}
    </Stack>
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
