/**
 * Project view model. The UI never infers state from model text: cards read
 * Thread records, the conversation reads Box envelopes, and details read each
 * Agent's Session. `reduceProject` folds the live stream into a snapshot.
 */
import type {
  ArtifactFact,
  ArtifactRef,
  BoxEnvelope,
  MemoryFact,
  ProjectRecord,
  ProjectSnapshot,
  ProjectStreamEvent,
  ResourceFact,
  ThreadRecord,
  ThreadState,
} from './project-types'

export interface Approval {
  id: string
  tool: string
  input: string
}

export interface ProjectState {
  project: ProjectRecord
  coordinatorId: string
  cursor: number
  threads: Record<string, ThreadRecord>
  /** Main conversation envelopes, ordered by arrival. */
  messages: BoxEnvelope[]
  /** Child → coordinator reports, used to show a thread's latest result on its card. */
  reports: BoxEnvelope[]
  memory: MemoryFact[]
  artifacts: ArtifactFact[]
  resources: ResourceFact[]
  /** Text an agent is producing right now, keyed by agent id. */
  live: Record<string, string>
  running: Record<string, boolean>
  approvals: Approval[]
  /** Every envelope seen, by id, so replies can point at their source. */
  envelopes: Record<string, BoxEnvelope>
}

/**
 * The messages an envelope answers. `causationId` is what the backend records
 * today; `replyTo` is the proposed explicit list (see web-contract.md).
 */
export function repliesOf(envelope: BoxEnvelope): string[] {
  const ids = [...(envelope.replyTo ?? []), ...(envelope.causationId ? [envelope.causationId] : [])]
  return [...new Set(ids)]
}

export function fromSnapshot(snapshot: ProjectSnapshot, localReplies: Record<string, string> = {}): ProjectState {
  const threads: Record<string, ThreadRecord> = {}
  for (const thread of snapshot.threads) threads[thread.id] = thread
  const running: Record<string, boolean> = {}
  for (const thread of snapshot.threads) if (thread.state === 'working') running[thread.id] = true
  // Replies the user picked are remembered locally until the server stores them.
  const withLocal = (envelope: BoxEnvelope): BoxEnvelope => {
    const local = localReplies[envelope.messageId]
    return local && !envelope.causationId ? { ...envelope, causationId: local } : envelope
  }
  const messages = snapshot.messages.map(withLocal)
  const envelopes: Record<string, BoxEnvelope> = {}
  for (const envelope of [...messages, ...snapshot.inboxMessages]) envelopes[envelope.messageId] = envelope
  return {
    envelopes,
    project: snapshot.project,
    coordinatorId: snapshot.coordinatorId,
    cursor: snapshot.cursor,
    threads,
    messages: sortByTime(messages),
    reports: sortByTime(snapshot.inboxMessages),
    memory: snapshot.memory.filter(m => !m.deleted),
    artifacts: snapshot.library.artifacts.filter(a => !a.deleted),
    resources: snapshot.library.resources.filter(r => !r.deleted),
    live: {},
    running,
    approvals: [],
  }
}

function sortByTime(list: readonly BoxEnvelope[]): BoxEnvelope[] {
  return [...list].sort((a, b) => a.createdAt - b.createdAt)
}

function upsert<T extends { id: string }>(list: readonly T[], record: T, deleted: boolean): T[] {
  const rest = list.filter(item => item.id !== record.id)
  if (deleted) return rest
  const index = list.findIndex(item => item.id === record.id)
  if (index < 0) return [...rest, record]
  const copy = list.slice()
  copy[index] = record
  return copy
}

export function reduceProject(state: ProjectState, event: ProjectStreamEvent): ProjectState {
  switch (event.type) {
    case 'message': {
      const envelope = event.envelope
      const cursor = Math.max(state.cursor, event.seq)
      const seen = (list: readonly BoxEnvelope[]) => list.some(m => m.messageId === envelope.messageId)
      // Keep reply links from the optimistic copy if the echo lacks them.
      const known = state.envelopes[envelope.messageId]
      const merged = known?.causationId && !envelope.causationId ? { ...envelope, causationId: known.causationId } : envelope
      let next: ProjectState = { ...state, cursor, envelopes: { ...state.envelopes, [envelope.messageId]: merged } }
      if (envelope.placement.kind === 'main' && !seen(state.messages)) {
        next = { ...next, messages: [...state.messages, envelope] }
      }
      const toCoordinator = envelope.sender.kind === 'agent' && envelope.sender.id !== state.coordinatorId
        && envelope.recipients.some(r => r.kind === 'agent' && r.id === state.coordinatorId)
      if (toCoordinator && !seen(state.reports)) next = { ...next, reports: [...state.reports, envelope] }
      // A published reply supersedes the text that was streaming for it.
      if (envelope.kind === 'agent-reply' && envelope.sender.kind === 'agent' && state.live[envelope.sender.id]) {
        const live = { ...next.live }
        delete live[envelope.sender.id]
        next = { ...next, live }
      }
      return next
    }
    case 'commit': {
      if (event.kind === 'agent' && event.data && typeof event.data === 'object') {
        // Commit frames carry the record's data but not always its timestamps.
        const data = event.data as Partial<ThreadRecord>
        const previous = state.threads[event.id]
        const now = Date.now()
        const thread = {
          ...previous,
          ...data,
          id: event.id,
          createdAt: data.createdAt ?? previous?.createdAt ?? now,
          updatedAt: data.updatedAt ?? now,
        } as ThreadRecord
        return { ...state, threads: { ...state.threads, [event.id]: thread } }
      }
      if (event.kind === 'memory') {
        const previous = state.memory.find(item => item.id === event.id)
        return { ...state, memory: upsert(state.memory, commitToFact(event, previous) as MemoryFact, event.deleted) }
      }
      if (event.kind === 'artifact') {
        const previous = state.artifacts.find(item => item.id === event.id)
        return { ...state, artifacts: upsert(state.artifacts, commitToFact(event, previous) as ArtifactFact, event.deleted) }
      }
      if (event.kind === 'resource') {
        const previous = state.resources.find(item => item.id === event.id)
        return { ...state, resources: upsert(state.resources, commitToFact(event, previous) as ResourceFact, event.deleted) }
      }
      if (event.kind === 'project' && event.id === state.project.id && event.data && typeof event.data === 'object') {
        return { ...state, project: { ...state.project, ...(event.data as Partial<ProjectRecord>) } }
      }
      return state
    }
    case 'chunk':
      return { ...state, live: { ...state.live, [event.agentId]: (state.live[event.agentId] ?? '') + event.text } }
    case 'agent-status': {
      const running = { ...state.running, [event.agentId]: event.status === 'running' }
      if (event.status === 'running') {
        // A new run starts a fresh draft.
        const live = { ...state.live }
        delete live[event.agentId]
        return { ...state, running, live }
      }
      return { ...state, running }
    }
    case 'approval/request':
      if (state.approvals.some(a => a.id === event.id)) return state
      return { ...state, approvals: [...state.approvals, { id: event.id, tool: event.tool, input: event.input }] }
    default:
      return state
  }
}

function commitToFact(
  event: Extract<ProjectStreamEvent, { type: 'commit' }>,
  previous?: { author: string; version: number; createdAt: number; source: FactSource },
) {
  const now = Date.now()
  return {
    kind: event.kind,
    id: event.id,
    seq: event.seq,
    // Older servers omit metadata on commit frames; editors re-read history
    // before writing, so an unknown version is safe.
    version: event.version ?? (previous ? previous.version + 1 : 0),
    data: event.data as Record<string, unknown>,
    author: event.author ?? previous?.author ?? '',
    source: event.source ?? previous?.source ?? {},
    createdAt: previous?.createdAt ?? event.updatedAt ?? now,
    updatedAt: event.updatedAt ?? now,
    deleted: event.deleted,
  }
}

type FactSource = { messageId?: string; sessionEventId?: string; agentId?: string }

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

/** What a message is answering, resolved for display. */
export interface ReplyRef {
  id: string
  who: 'you' | 'coordinator' | 'thread'
  /** Display name of the author, e.g. "You", "Coordinator" or a thread label. */
  label: string
  /** The agent id to draw an avatar for, when the author is an agent. */
  agentId?: string
  /** Thread the message belongs to, when it lives outside the main conversation. */
  threadId?: string
  excerpt: string
  /** Whether the source is rendered in the main conversation (so it can be scrolled to). */
  inMain: boolean
}

export function replyRef(state: ProjectState, id: string): ReplyRef | undefined {
  const source = state.envelopes[id]
  if (!source) return undefined
  const inMain = source.placement.kind === 'main' && (source.kind === 'user-message' || source.kind === 'agent-reply')
  if (source.sender.kind === 'user') {
    // "The user wrote in thread …" notices point at a message sent to a thread.
    const threadId = source.threadId ?? (source.placement.kind === 'thread' ? source.placement.threadId : undefined)
    const quoted = source.kind === 'notice' ? source.text.replace(/^The user wrote in thread "[^"]*" \([^)]*\): /, '') : source.text
    return {
      id,
      who: 'you',
      label: threadId ? `You → ${state.threads[threadId]?.label ?? 'thread'}` : 'You',
      ...(threadId ? { threadId } : {}),
      excerpt: plainPreview(quoted, 110),
      inMain,
    }
  }
  const agentId = source.sender.id
  if (agentId === state.coordinatorId) {
    return { id, who: 'coordinator', label: 'Coordinator', agentId, excerpt: plainPreview(source.text, 110), inMain }
  }
  return {
    id,
    who: 'thread',
    label: state.threads[agentId]?.label ?? 'Thread',
    agentId,
    threadId: agentId,
    excerpt: plainPreview(source.text, 110),
    inMain,
  }
}

export type MainItem =
  | { kind: 'user'; id: string; text: string; at: number; replyTo: ReplyRef[] }
  | { kind: 'coordinator'; id: string; text: string; at: number; replyTo: ReplyRef[]; refs: ArtifactRef[] }
  | { kind: 'threads'; id: string; threadIds: string[]; at: number }
  | { kind: 'draft'; id: string; text: string }

/**
 * The main conversation: what the user said, what the coordinator said, and
 * one card per thread where work was handed off. Thread results, notices and
 * internal steps stay out of it; they live in their own thread.
 */
export function mainTimeline(state: ProjectState): MainItem[] {
  const items: MainItem[] = []
  // A reply to the message right above it needs no link; anything further away does.
  const refs = (message: BoxEnvelope): ReplyRef[] => {
    let previous: MainItem | undefined
    for (let i = items.length - 1; i >= 0 && !previous; i -= 1) {
      const item = items[i]!
      if (item.kind === 'user' || item.kind === 'coordinator') previous = item
    }
    return repliesOf(message)
      .filter(id => id !== previous?.id)
      .map(id => replyRef(state, id))
      .filter((ref): ref is ReplyRef => ref !== undefined)
  }
  for (const message of state.messages) {
    switch (message.kind) {
      case 'user-message':
        items.push({ kind: 'user', id: message.messageId, text: message.text, at: message.createdAt, replyTo: refs(message) })
        break
      case 'agent-reply':
        if (message.text.trim() || message.refs?.length) {
          items.push({ kind: 'coordinator', id: message.messageId, text: message.text, at: message.createdAt, replyTo: refs(message), refs: message.refs ?? [] })
        }
        break
      case 'dispatch': {
        if (!message.threadId) break
        const last = items.at(-1)
        if (last?.kind === 'threads') {
          if (!last.threadIds.includes(message.threadId)) last.threadIds.push(message.threadId)
        } else {
          items.push({ kind: 'threads', id: message.messageId, threadIds: [message.threadId], at: message.createdAt })
        }
        break
      }
      default:
        break
    }
  }
  const draft = state.live[state.coordinatorId]
  if (draft?.trim()) items.push({ kind: 'draft', id: 'coordinator-draft', text: draft })
  return items
}

/** Worker threads, excluding the coordinator itself. */
export function workerThreads(state: ProjectState): ThreadRecord[] {
  return Object.values(state.threads)
    .filter(thread => thread.id !== state.coordinatorId)
    .sort((a, b) => a.createdAt - b.createdAt)
}

export function latestReport(state: ProjectState, threadId: string): BoxEnvelope | undefined {
  for (let i = state.reports.length - 1; i >= 0; i -= 1) {
    const report = state.reports[i]
    if (report?.sender.kind === 'agent' && report.sender.id === threadId) return report
  }
  return undefined
}

export type ThreadTone = 'working' | 'attention' | 'idle' | 'done' | 'failed'

export const THREAD_STATE: Record<ThreadState, { label: string; tone: ThreadTone }> = {
  working: { label: 'Working', tone: 'working' },
  waiting: { label: 'Waiting on a decision', tone: 'attention' },
  blocked: { label: 'Blocked', tone: 'attention' },
  idle: { label: 'Idle', tone: 'idle' },
  done: { label: 'Done', tone: 'done' },
  failed: { label: 'Failed', tone: 'failed' },
}

/**
 * The one line a card shows: the state, and while working the step the
 * thread's live checklist marks active (or how far through it is).
 */
export function threadStatusLine(state: ProjectState, thread: ThreadRecord): { label: string; tone: ThreadTone; step?: string } {
  const current = threadState(state, thread)
  const { label, tone } = THREAD_STATE[current]
  const items = thread.checklist ?? []
  if (current !== 'working' || items.length === 0) return { label, tone }
  const active = items.find(item => item.status === 'active')
  const done = items.filter(item => item.status === 'done').length
  return { label, tone, step: active ? active.title : `${done} of ${items.length} steps` }
}

/** States a thread reaches that the user should hear about. */
const SETTLED: ReadonlySet<ThreadState> = new Set(['done', 'failed', 'waiting', 'blocked'])

/**
 * A thread reported, failed or needs a decision since the user last opened
 * it. `seen` maps thread id → the `updatedAt` the user last saw.
 */
export function isUnread(state: ProjectState, thread: ThreadRecord, seen: Readonly<Record<string, number>>): boolean {
  if (!SETTLED.has(threadState(state, thread))) return false
  return (seen[thread.id] ?? 0) < thread.updatedAt
}

/** Library entries for a message's artifact references, in reference order. */
export function artifactsFor(state: ProjectState, refs: readonly ArtifactRef[]): ArtifactFact[] {
  return refs
    .map(ref => state.artifacts.find(artifact => artifact.id === ref.hash))
    .filter((artifact): artifact is ArtifactFact => artifact !== undefined)
}

/** Artifacts a thread published, oldest first. */
export function threadArtifacts(state: ProjectState, threadId: string): ArtifactFact[] {
  return state.artifacts.filter(artifact => artifact.author === threadId).sort((a, b) => a.createdAt - b.createdAt)
}

/** Effective state: the live run flag wins over a stale record. */
export function threadState(state: ProjectState, thread: ThreadRecord): ThreadState {
  if (state.running[thread.id] && thread.state !== 'failed') return 'working'
  if (thread.state === 'working' && state.running[thread.id] === false) return 'idle'
  return thread.state
}

export interface OverviewGroup {
  key: 'attention' | 'working' | 'reported' | 'finished'
  label: string
  threads: ThreadRecord[]
}

/** Overview: what needs you first, then what is moving, then the rest. */
export function overview(state: ProjectState): OverviewGroup[] {
  const groups: OverviewGroup[] = [
    { key: 'attention', label: 'Needs attention', threads: [] },
    { key: 'working', label: 'Working', threads: [] },
    { key: 'reported', label: 'Idle', threads: [] },
    { key: 'finished', label: 'Finished', threads: [] },
  ]
  for (const thread of workerThreads(state)) {
    const current = threadState(state, thread)
    const index = current === 'waiting' || current === 'blocked' || current === 'failed' ? 0
      : current === 'working' ? 1
        : current === 'idle' ? 2 : 3
    groups[index]!.threads.push(thread)
  }
  for (const group of groups) group.threads.sort((a, b) => b.updatedAt - a.updatedAt)
  return groups.filter(group => group.threads.length > 0)
}

export function activeCount(state: ProjectState): number {
  return workerThreads(state).filter(thread => threadState(state, thread) === 'working').length
}

/** One line of plain text from Markdown, for previews. */
export function plainPreview(text: string, max = 180): string {
  const clean = text.replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
