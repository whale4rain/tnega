import {
  Archive,
  BookOpen,
  Brain,
  FileText,
  History,
  Link2,
  Pencil,
  Plus,
  Trash2,
  Upload,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { ApiError } from '../../lib/api'
import { errorText, relativeTime } from '../../lib/hooks'
import { confirmDialog } from '../../lib/dialogs'
import { isUnsupported, projectApi } from '../../lib/project-api'
import type { ProjectState } from '../../lib/project-model'
import { formatBytes } from '../../lib/project-model'
import type {
  ArtifactFact,
  CheckIns,
  MemoryFact,
  ProjectSettings,
  ProjectUsage,
  ThreadSpawning,
  UpdateDetail,
} from '../../lib/project-types'
import { formatTokens } from '../../lib/timeline'
import type { ConfigSnapshot, Effort, Permission } from '../../lib/types'
import { Dialog } from '../Dialog'
import { ARTIFACT_KIND, ArtifactIcon, ArtifactViewer, artifactKind, type ArtifactKind } from './Artifacts'

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export function MemoryPanel({ workspace, state }: { workspace: string; state: ProjectState }) {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | undefined>()
  const projectId = state.project.id
  const add = async () => {
    const text = draft.trim()
    if (!text) return
    const tags = [...text.matchAll(/#([\w-]+)/g)].map(match => match[1]!)
    try {
      await projectApi.addMemory(workspace, projectId, text, tags)
      setDraft('')
      setError(undefined)
    } catch (reason) {
      setError(errorText(reason))
    }
  }
  const sorted = [...state.memory].sort((a, b) => b.seq - a.seq)
  return (
    <div className="panel-stack">
      <p className="panel-intro">Shared memory is what every thread draws on: decisions, conventions, and context. Agents add to it as they work; you can correct anything.</p>
      <div className="memory-add">
        <textarea
          value={draft}
          rows={2}
          placeholder="Add something every thread should know… (#tags optional)"
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void add()
          }}
        />
        <div className="memory-add-footer">
          <span className="muted small">Ctrl+Enter to save</span>
          <button type="button" className="button primary small" onClick={() => void add()} disabled={!draft.trim()}><Plus size={13} /> Remember</button>
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {sorted.length === 0 && (
        <div className="panel-empty">
          <Brain size={22} />
          <p>Nothing remembered yet.</p>
          <span>Things like "release moved to Friday" or "ask Sam before touching billing" belong here.</span>
        </div>
      )}
      <div className="memory-list">
        {sorted.map(record => <MemoryItem key={record.id} workspace={workspace} state={state} record={record} />)}
      </div>
    </div>
  )
}

function MemoryItem({ workspace, state, record }: { workspace: string; state: ProjectState; record: MemoryFact }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(record.data.text)
  const [history, setHistory] = useState<MemoryFact[] | undefined>()
  const [error, setError] = useState<string | undefined>()
  const projectId = state.project.id

  /** Stream commits carry no version, so read the latest before writing. */
  const currentVersion = async () => {
    const result = await projectApi.memoryHistory(workspace, projectId, record.id)
    return result.history.at(-1)?.version ?? record.version
  }

  const save = async () => {
    try {
      await projectApi.editMemory(workspace, projectId, record.id, {
        text: draft.trim(),
        expectedVersion: await currentVersion(),
        ...(record.data.tags ? { tags: record.data.tags } : {}),
      })
      setEditing(false)
      setError(undefined)
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409) {
        setError('Someone changed this while you were editing. Your text is kept; review and save again.')
      } else {
        setError(errorText(reason))
      }
    }
  }

  const remove = async () => {
    if (!await confirmDialog({ title: 'Forget this memory?', message: 'It stays in the version history.', confirmLabel: 'Forget', danger: true })) return
    try {
      await projectApi.deleteMemory(workspace, projectId, record.id, await currentVersion())
    } catch (reason) {
      setError(errorText(reason))
    }
  }

  const toggleHistory = async () => {
    if (history) {
      setHistory(undefined)
      return
    }
    try {
      setHistory((await projectApi.memoryHistory(workspace, projectId, record.id)).history)
    } catch (reason) {
      setError(errorText(reason))
    }
  }

  return (
    <div className="memory-item">
      {editing
        ? (
          <div className="memory-edit">
            <textarea value={draft} autoFocus rows={3} onChange={event => setDraft(event.target.value)} />
            <div className="memory-add-footer">
              <button type="button" className="button ghost small" onClick={() => { setEditing(false); setDraft(record.data.text) }}>Cancel</button>
              <button type="button" className="button primary small" onClick={() => void save()} disabled={!draft.trim()}>Save</button>
            </div>
          </div>
        )
        : <p className="memory-text">{record.data.text}</p>}
      {record.data.tags?.length ? (
        <div className="memory-tags">{record.data.tags.map(tag => <span key={tag} className="tag">#{tag}</span>)}</div>
      ) : null}
      <div className="memory-meta">
        <span>{[record.author || record.source.agentId ? authorName(state, record.author || record.source.agentId) : undefined, record.updatedAt ? relativeTime(record.updatedAt) : undefined].filter(Boolean).join(' · ')}</span>
        {!editing && (
          <span className="memory-actions">
            <button type="button" className="icon-button tiny" aria-label="Version history" title="Version history" onClick={() => void toggleHistory()}><History size={13} /></button>
            <button type="button" className="icon-button tiny" aria-label="Edit" title="Edit" onClick={() => setEditing(true)}><Pencil size={13} /></button>
            <button type="button" className="icon-button tiny" aria-label="Forget" title="Forget" onClick={() => void remove()}><Trash2 size={13} /></button>
          </span>
        )}
      </div>
      {error && <div className="notice notice-warn">{error}</div>}
      {history && (
        <ol className="memory-history">
          {[...history].reverse().map(version => (
            <li key={version.version}>
              <span className="memory-version">v{version.version}</span>
              <span className={version.deleted ? 'struck' : undefined}>{version.data.text}</span>
              <span className="muted small">{authorName(state, version.author)} · {relativeTime(version.updatedAt)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

export function authorName(state: ProjectState, author: string | undefined): string {
  if (!author) return 'Agent'
  if (author === 'user') return 'You'
  const id = author.replace(/^agent:/, '')
  if (id === state.coordinatorId) return 'Coordinator'
  return state.threads[id]?.label ?? 'Agent'
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

export function LibraryPanel({ workspace, state }: { workspace: string; state: ProjectState }) {
  const [viewing, setViewing] = useState<ArtifactFact | undefined>()
  const [adding, setAdding] = useState(false)
  const [filter, setFilter] = useState<ArtifactKind | 'links' | 'all'>('all')
  const everything = [...state.artifacts].sort((a, b) => b.seq - a.seq)
  const kinds = [...new Set(everything.map(artifact => artifactKind(artifact.data.mediaType)))]
  const artifacts = filter === 'all' ? everything : filter === 'links' ? [] : everything.filter(artifact => artifactKind(artifact.data.mediaType) === filter)
  const resources = filter === 'all' || filter === 'links' ? [...state.resources].sort((a, b) => b.seq - a.seq) : []
  return (
    <div className="wb-view" aria-label="Library">
      <div className="wb-toolbar">
        <span className="wb-toolbar-title">Library</span>
        <button type="button" className="button secondary small" onClick={() => setAdding(true)}><Upload size={13} /> Add</button>
      </div>
      <div className="wb-card wb-scroll">
    <div className="panel-stack">
      {(kinds.length > 1 || (kinds.length > 0 && state.resources.length > 0)) && (
        <div className="library-filters" role="group" aria-label="Show">
          <button type="button" className={`board-chip${filter === 'all' ? ' active' : ''}`} onClick={() => setFilter('all')}>All</button>
          {kinds.map(kind => (
            <button key={kind} type="button" className={`board-chip${filter === kind ? ' active' : ''}`} onClick={() => setFilter(kind)}>{ARTIFACT_KIND[kind].plural}</button>
          ))}
          {state.resources.length > 0 && <button type="button" className={`board-chip${filter === 'links' ? ' active' : ''}`} onClick={() => setFilter('links')}>Links</button>}
        </div>
      )}
      {artifacts.length === 0 && resources.length === 0 && (
        <div className="panel-empty">
          <BookOpen size={22} />
          <p>The library is empty.</p>
          <span>Artifacts that threads publish (reports, patches, drafts) and links you add appear here.</span>
        </div>
      )}
      {artifacts.length > 0 && (
        <section className="panel-section">
          <h3 className="panel-heading">Artifacts <span className="count">{artifacts.length}</span></h3>
          <div className="library-list">
            {artifacts.map(artifact => (
              <button key={artifact.id} type="button" className="library-row" onClick={() => setViewing(artifact)}>
                <span className="library-icon"><ArtifactIcon mediaType={artifact.data.mediaType} /></span>
                <span className="library-main">
                  <span className="library-title">{artifact.data.title}</span>
                  <span className="library-meta">
                    {ARTIFACT_KIND[artifactKind(artifact.data.mediaType)].label} · {formatBytes(artifact.data.size)}
                    {artifact.author ? ` · ${authorName(state, artifact.author)}` : ''}
                    {` · ${relativeTime(artifact.createdAt)}`}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
      {resources.length > 0 && (
        <section className="panel-section">
          <h3 className="panel-heading">Sources <span className="count">{resources.length}</span></h3>
          <div className="library-list">
            {resources.map(resource => (
              <a key={resource.id} className="library-row" href={resource.data.uri} target="_blank" rel="noreferrer noopener">
                <span className="library-icon"><Link2 size={15} /></span>
                <span className="library-main">
                  <span className="library-title">{resource.data.title}</span>
                  <span className="library-meta">{resource.data.note || resource.data.uri}</span>
                </span>
              </a>
            ))}
          </div>
        </section>
      )}
      {viewing && <ArtifactViewer workspace={workspace} projectId={state.project.id} artifact={viewing} onClose={() => setViewing(undefined)} />}
      {adding && <AddToLibraryDialog workspace={workspace} projectId={state.project.id} onClose={() => setAdding(false)} />}
    </div>
      </div>
    </div>
  )
}


function AddToLibraryDialog({ workspace, projectId, onClose }: { workspace: string; projectId: string; onClose: () => void }) {
  const [mode, setMode] = useState<'file' | 'link'>('file')
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [mediaType, setMediaType] = useState('text/plain')
  const [uri, setUri] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const pickFile = async (file: File | undefined) => {
    if (!file) return
    if (file.size > 2 * 1024 * 1024) {
      setError('Files up to 2 MB can be added from the browser.')
      return
    }
    setTitle(current => current || file.name)
    setMediaType(file.type || (file.name.endsWith('.md') ? 'text/markdown' : 'text/plain'))
    setContent(await file.text())
  }

  const save = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await projectApi.addToLibrary(workspace, projectId, mode === 'file'
        ? { title: title.trim(), content, mediaType }
        : { title: title.trim(), uri: uri.trim(), ...(note.trim() ? { note: note.trim() } : {}) })
      onClose()
    } catch (reason) {
      setError(isUnsupported(reason)
        ? 'This server cannot add library items yet (POST /api/projects/:id/library). Agents can still publish artifacts.'
        : errorText(reason))
    } finally {
      setBusy(false)
    }
  }

  const valid = title.trim() && (mode === 'file' ? content.trim() : /^https?:\/\//.test(uri.trim()))
  return (
    <Dialog
      title="Add to library"
      description="Threads can read everything in the library."
      onClose={onClose}
      footer={
        <>
          {error && <span className="form-error">{error}</span>}
          <button type="button" className="button ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="button primary" onClick={() => void save()} disabled={!valid || busy}>Add</button>
        </>
      }
    >
      <div className="segmented wide" role="radiogroup" aria-label="Kind">
        <button type="button" role="radio" aria-checked={mode === 'file'} className={mode === 'file' ? 'active' : undefined} onClick={() => setMode('file')}><FileText size={14} /> Text or file</button>
        <button type="button" role="radio" aria-checked={mode === 'link'} className={mode === 'link' ? 'active' : undefined} onClick={() => setMode('link')}><Link2 size={14} /> Link</button>
      </div>
      <label className="field">
        <span className="field-label">Title</span>
        <input value={title} onChange={event => setTitle(event.target.value)} placeholder="e.g. Brand guidelines" />
      </label>
      {mode === 'file'
        ? (
          <label className="field">
            <span className="field-label">Content</span>
            <textarea className="field-textarea" rows={8} value={content} onChange={event => setContent(event.target.value)} placeholder="Paste text, or choose a file below" />
            <span className="input-row">
              <input ref={fileInput} type="file" hidden accept=".md,.txt,.json,.csv,.ts,.js,.py,.html,.css,.yaml,.yml,text/*" onChange={event => void pickFile(event.target.files?.[0])} />
              <button type="button" className="button secondary small" onClick={() => fileInput.current?.click()}><Upload size={13} /> Choose file…</button>
              <span className="muted small">{mediaType}</span>
            </span>
          </label>
        )
        : (
          <>
            <label className="field">
              <span className="field-label">URL</span>
              <input value={uri} onChange={event => setUri(event.target.value)} placeholder="https://…" />
            </label>
            <label className="field">
              <span className="field-label">Note</span>
              <input value={note} onChange={event => setNote(event.target.value)} placeholder="Why it matters (optional)" />
            </label>
          </>
        )}
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const CHECK_INS: Array<{ value: CheckIns; label: string; hint: string }> = [
  { value: 'often', label: 'Often', hint: 'Brief me as each thread makes progress' },
  { value: 'milestones', label: 'At milestones', hint: 'When a thread finishes or needs me' },
  { value: 'end', label: 'At the end', hint: 'One report when the work is done' },
]
const SPAWNING: Array<{ value: ThreadSpawning; label: string; hint: string }> = [
  { value: 'ask-first', label: 'Ask first', hint: 'Propose threads and wait for my go-ahead' },
  { value: 'balanced', label: 'Balanced', hint: 'Start threads for clearly separate work' },
  { value: 'proactive', label: 'Proactive', hint: 'Parallelize whenever it helps' },
]
const DETAIL: Array<{ value: UpdateDetail; label: string; hint: string }> = [
  { value: 'brief', label: 'Brief', hint: 'A line or two' },
  { value: 'standard', label: 'Standard', hint: 'What changed and why' },
  { value: 'detailed', label: 'Detailed', hint: 'Full reasoning and evidence' },
]

export function SettingsPanel({
  workspace,
  state,
  config,
  onDeleted,
}: {
  workspace: string
  state: ProjectState
  config: ConfigSnapshot | undefined
  onDeleted: () => void
}) {
  const project = state.project
  const initial = project.settings ?? {}
  const [goal, setGoal] = useState(project.goal ?? '')
  const [instructions, setInstructions] = useState(initial.instructions ?? '')
  const [coordinator, setCoordinator] = useState(initial.coordinator ?? {})
  const [threads, setThreads] = useState(initial.threads ?? {})
  const [checkIns, setCheckIns] = useState<CheckIns>(initial.preferences?.checkIns ?? 'milestones')
  const [spawning, setSpawning] = useState<ThreadSpawning>(initial.preferences?.threadSpawning ?? 'balanced')
  const [detail, setDetail] = useState<UpdateDetail>(initial.preferences?.updateDetail ?? 'standard')
  const [permission, setPermission] = useState<Permission>(initial.permission ?? 'workspace-write')
  const [parallel, setParallel] = useState(initial.maxParallelThreads ?? 4)
  const [status, setStatus] = useState<{ tone: 'ok' | 'info' | 'error'; text: string } | undefined>()
  const [usage, setUsage] = useState<ProjectUsage | null | undefined>()

  useEffect(() => {
    projectApi.usage(workspace, project.id).then(setUsage, () => setUsage(null))
  }, [workspace, project.id])

  const save = async () => {
    const settings: ProjectSettings = {
      instructions: instructions.trim(),
      coordinator,
      threads,
      preferences: { checkIns, threadSpawning: spawning, updateDetail: detail },
      permission,
      maxParallelThreads: parallel,
    }
    try {
      await projectApi.saveSettings(workspace, project.id, { goal: goal.trim(), settings })
      setStatus({ tone: 'ok', text: 'Saved. New work picks up these settings.' })
    } catch (reason) {
      setStatus(isUnsupported(reason)
        ? { tone: 'info', text: 'This server cannot store project settings yet (PATCH /api/projects/:id with `settings`). See docs/project/web-contract.md.' }
        : { tone: 'error', text: errorText(reason) })
    }
  }

  const archive = async () => {
    try {
      await projectApi.archive(workspace, project.id, !project.archived)
      setStatus({ tone: 'ok', text: project.archived ? 'Project restored.' : 'Project archived. It stays readable.' })
    } catch (reason) {
      setStatus({ tone: 'error', text: errorText(reason) })
    }
  }

  const remove = async () => {
    if (!await confirmDialog({
      title: 'Delete project?',
      message: `“${project.name}” will be deleted with all of its threads, memory and library. This can't be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    })) return
    try {
      await projectApi.remove(workspace, project.id)
      onDeleted()
    } catch (reason) {
      setStatus({ tone: 'error', text: errorText(reason) })
    }
  }

  const models = config?.models ?? []
  return (
    <div className="wb-view" aria-label="Project settings">
      <div className="wb-toolbar">
        <span className="wb-toolbar-title">Project settings</span>
      </div>
      <div className="wb-card wb-scroll">
    <div className="panel-stack settings-panel">
      <section className="panel-section">
        <h3 className="panel-heading">Brief</h3>
        <label className="field">
          <span className="field-label">Goal</span>
          <textarea className="field-textarea" rows={2} value={goal} onChange={event => setGoal(event.target.value)} placeholder="What this project is for" />
        </label>
        <label className="field">
          <span className="field-label">Instructions</span>
          <textarea className="field-textarea" rows={4} value={instructions} onChange={event => setInstructions(event.target.value)} placeholder="How the coordinator and every thread should work: standards, people to check with, things to avoid…" />
        </label>
      </section>

      <section className="panel-section">
        <h3 className="panel-heading">Memory</h3>
        <MemoryPanel workspace={workspace} state={state} />
      </section>

      <section className="panel-section">
        <h3 className="panel-heading">How it works with you</h3>
        <Segments label="Check-ins" options={CHECK_INS} value={checkIns} onChange={setCheckIns} />
        <Segments label="Starting threads" options={SPAWNING} value={spawning} onChange={setSpawning} />
        <Segments label="Update detail" options={DETAIL} value={detail} onChange={setDetail} />
      </section>

      <section className="panel-section">
        <h3 className="panel-heading">Models</h3>
        <RoleModelFields label="Coordinator" value={coordinator} onChange={setCoordinator} models={models} defaultModel={config?.effective.modelId} />
        <RoleModelFields label="Threads" value={threads} onChange={setThreads} models={models} defaultModel={config?.effective.modelId} />
        <div className="form-grid">
          <label className="field">
            <span className="field-label">Thread permission</span>
            <select value={permission} onChange={event => setPermission(event.target.value as Permission)}>
              <option value="read-only">Read only</option>
              <option value="workspace-write">Workspace write</option>
              <option value="bypass">Full access</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">Parallel threads</span>
            <input type="number" min={1} max={16} value={parallel} onChange={event => setParallel(Math.max(1, Math.min(16, Number(event.target.value) || 1)))} />
          </label>
        </div>
      </section>

      <div className="settings-save">
        {status && <span className={`settings-status tone-${status.tone}`}>{status.text}</span>}
        <button type="button" className="button primary" onClick={() => void save()}>Save settings</button>
      </div>

      <section className="panel-section">
        <h3 className="panel-heading">Usage</h3>
        {usage === undefined && <div className="skeleton-line w60" />}
        {usage === null && <p className="muted small">Usage reporting is not available on this server yet (GET /api/projects/:id/usage).</p>}
        {usage && <UsageTable state={state} usage={usage} />}
      </section>

      <section className="panel-section danger-zone">
        <h3 className="panel-heading">Project</h3>
        <div className="danger-row">
          <span><strong>{project.archived ? 'Restore project' : 'Archive project'}</strong><br /><span className="muted small">{project.archived ? 'Move it back to your active projects.' : 'Hide it from the list; everything stays readable.'}</span></span>
          <button type="button" className="button secondary small" onClick={() => void archive()}><Archive size={13} /> {project.archived ? 'Restore' : 'Archive'}</button>
        </div>
        <div className="danger-row">
          <span><strong>Delete project</strong><br /><span className="muted small">Removes threads, memory and library.</span></span>
          <button type="button" className="button danger small" onClick={() => void remove()}><Trash2 size={13} /> Delete</button>
        </div>
      </section>
    </div>
      </div>
    </div>
  )
}

function Segments<T extends string>({ label, options, value, onChange }: { label: string; options: Array<{ value: T; label: string; hint: string }>; value: T; onChange: (value: T) => void }) {
  const current = options.find(option => option.value === value)
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="segmented wide" role="radiogroup" aria-label={label}>
        {options.map(option => (
          <button key={option.value} type="button" role="radio" aria-checked={option.value === value} className={option.value === value ? 'active' : undefined} onClick={() => onChange(option.value)}>
            {option.label}
          </button>
        ))}
      </div>
      {current && <span className="field-hint">{current.hint}</span>}
    </div>
  )
}

function RoleModelFields({
  label,
  value,
  onChange,
  models,
  defaultModel,
}: {
  label: string
  value: { model?: string; reasoningEffort?: Effort }
  onChange: (value: { model?: string; reasoningEffort?: Effort }) => void
  models: ConfigSnapshot['models']
  defaultModel: string | undefined
}) {
  const active = models.find(model => model.id === (value.model || defaultModel))
  return (
    <div className="form-grid">
      <label className="field">
        <span className="field-label">{label} model</span>
        <select value={value.model ?? ''} onChange={event => onChange({ ...value, ...(event.target.value ? { model: event.target.value } : { model: undefined }) } as typeof value)}>
          <option value="">Default{defaultModel ? ` (${defaultModel})` : ''}</option>
          {models.map(model => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}
        </select>
      </label>
      <label className="field">
        <span className="field-label">{label} effort</span>
        <select
          value={value.reasoningEffort ?? ''}
          disabled={!active?.reasoningEfforts.length}
          onChange={event => onChange({ ...value, reasoningEffort: (event.target.value || undefined) as Effort | undefined } as typeof value)}
        >
          <option value="">Default</option>
          {(active?.reasoningEfforts ?? []).map(effort => <option key={effort} value={effort}>{effort[0]!.toUpperCase() + effort.slice(1)}</option>)}
        </select>
      </label>
    </div>
  )
}

function UsageTable({ state, usage }: { state: ProjectState; usage: ProjectUsage }) {
  return (
    <table className="usage-table">
      <thead><tr><th>Agent</th><th>Input</th><th>Output</th><th>Cached</th></tr></thead>
      <tbody>
        {usage.byThread.map(row => (
          <tr key={row.threadId}>
            <td>{row.threadId === state.coordinatorId ? 'Coordinator' : state.threads[row.threadId]?.label ?? row.threadId.slice(0, 8)}</td>
            <td>{formatTokens(row.promptTokens)}</td>
            <td>{formatTokens(row.completionTokens)}</td>
            <td>{formatTokens(row.cachedTokens)}</td>
          </tr>
        ))}
        <tr className="usage-total">
          <td>Total</td>
          <td>{formatTokens(usage.total.promptTokens)}</td>
          <td>{formatTokens(usage.total.completionTokens)}</td>
          <td>{formatTokens(usage.total.cachedTokens)}</td>
        </tr>
      </tbody>
    </table>
  )
}

