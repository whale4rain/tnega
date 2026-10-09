/**
 * Wire contract for Projects (`packages/cli/src/project-routes.ts`).
 *
 * Mirrors Claude Projects (2026-09-17): a coordinator conversation that
 * dispatches work to parallel Threads, which draw on a shared Memory and a
 * Library of files and artifacts.
 *
 * Fields marked "proposed" are not served by the backend yet; the UI treats
 * them as optional and degrades when they are missing. See
 * `docs/project/web-contract.md`.
 */
import type { Effort, Permission, SessionEvent } from './types'

export interface ProjectRecord {
  id: string
  name: string
  goal?: string
  archived?: boolean
  paused?: boolean
  coordinatorId: string
  createdAt: number
  updatedAt: number
  /** Proposed: settings the coordinator and threads run with. */
  settings?: ProjectSettings
  /** In the project list only: where its threads stand. Older servers omit it. */
  threads?: ProjectThreadSummary
}

/** Threads waiting on the user (or blocked), failed, and working now. */
export interface ProjectThreadSummary {
  waiting: number
  failed: number
  working: number
}

export type CheckIns = 'often' | 'milestones' | 'end'
export type ThreadSpawning = 'ask-first' | 'balanced' | 'proactive'
export type UpdateDetail = 'brief' | 'standard' | 'detailed'

export interface RoleModel {
  /** Model route id from System Config; absent means the default model. */
  model?: string
  reasoningEffort?: Effort
}

/** Proposed. Matches Claude's per-project preferences and model choices. */
export interface ProjectSettings {
  instructions?: string
  coordinator?: RoleModel
  threads?: RoleModel
  preferences?: {
    checkIns?: CheckIns
    threadSpawning?: ThreadSpawning
    updateDetail?: UpdateDetail
  }
  /** Upper bound for every thread; threads can only narrow it. */
  permission?: Permission
  /** Maximum threads working at the same time. */
  maxParallelThreads?: number
}

export type ThreadState = 'working' | 'waiting' | 'blocked' | 'idle' | 'done' | 'failed' | 'resolved'

/** One step of a thread's live checklist (`update_checklist`). */
export interface ChecklistItem {
  title: string
  status: 'pending' | 'active' | 'done'
}

export interface ThreadRecord {
  id: string
  projectId: string
  parentId?: string
  label: string
  goal: string
  expect?: string
  state: ThreadState
  detail?: string
  depth: number
  permission: Permission
  checklist?: ChecklistItem[]
  createdAt: number
  updatedAt: number
}

export type BoxAddress = { kind: 'user'; id: 'user' } | { kind: 'agent'; id: string }

export type BoxMessageKind =
  | 'user-message'
  | 'user-thread'
  | 'agent-reply'
  | 'dispatch'
  | 'progress'
  | 'request'
  | 'complete'
  | 'blocked'
  | 'failed'
  | 'notice'

export interface ArtifactRef {
  hash: string
  size: number
  mediaType: string
}

export interface BoxEnvelope {
  messageId: string
  projectId: string
  sender: BoxAddress
  recipients: BoxAddress[]
  placement: { kind: 'main' } | { kind: 'thread'; threadId: string }
  kind: BoxMessageKind
  text: string
  refs: ArtifactRef[]
  threadId?: string
  causationId?: string
  /** Interrupt the recipient's current run before processing this correction. */
  interrupt?: boolean
  /** Proposed: every message this one answers, when an agent replies to several at once. */
  replyTo?: string[]
  createdAt: number
}

export interface FactRecord<T = Record<string, unknown>> {
  kind: string
  id: string
  seq: number
  version: number
  data: T
  author: string
  source: { messageId?: string; sessionEventId?: string; agentId?: string }
  createdAt: number
  updatedAt: number
  deleted: boolean
}

export type RoutineSchedule =
  | { kind: 'daily'; time: string }
  | { kind: 'weekdays'; time: string }
  | { kind: 'weekly'; time: string; weekday: number }
  | { kind: 'interval'; minutes: number }

export interface RoutineData {
  title: string
  prompt: string
  schedule: RoutineSchedule
  enabled: boolean
  threadId?: string
  nextRunAt: number
  lastRunAt?: number
  lastError?: string
}

export type RoutineFact = FactRecord<RoutineData>

export type MemoryFact = FactRecord<{ text: string; tags?: string[] }>
export type ArtifactFact = FactRecord<{ title: string; hash: string; size: number; mediaType: string }>
/**
 * A push or pull request a thread made with its shell, recorded by the
 * server as a resource (`packages/cli/src/project-git.ts`). Older servers
 * never write it.
 */
export interface GitInfo {
  kind: 'push' | 'pull-request'
  status: 'pushed' | 'up-to-date' | 'rejected' | 'failed' | 'opened'
  repo?: string
  branch?: string
  number?: number
  detail?: string
}

export type ResourceFact = FactRecord<{ title: string; uri: string; note?: string; git?: GitInfo }>

export interface ProjectSnapshot {
  /** Authoritative live states; absent on older hosts. */
  running?: Record<string, boolean>
  project: ProjectRecord
  coordinatorId: string
  cursor: number
  threads: ThreadRecord[]
  messages: BoxEnvelope[]
  inboxMessages: BoxEnvelope[]
  /** User-facing Thread chat; older servers omit this field. */
  threadMessages?: BoxEnvelope[]
  /** Agent-to-Agent envelopes for inspectable exchanges; older servers omit this. */
  agentMessages?: BoxEnvelope[]
  memory: MemoryFact[]
  library: { artifacts: ArtifactFact[]; resources: ResourceFact[] }
  /** Older servers omit routines. */
  routines?: RoutineFact[]
}

export interface ThreadDetail {
  thread: ThreadRecord
  events: SessionEvent[]
}

/** `GET /api/projects/:id/usage?since=`. */
export interface ProjectUsage {
  total: UsageTotals
  /** Totals since the `since` asked for (the Board asks for today). */
  since?: UsageTotals
  byThread: Array<UsageTotals & { threadId: string; lastActiveAt?: number }>
}

export interface UsageTotals {
  responses: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  /** Time spent inside turns. */
  activeMs?: number
  turns?: number
}

/** Frames of `GET /api/projects/:id/stream`. */
export type ProjectStreamEvent =
  | { type: 'snapshot'; snapshot: ProjectSnapshot }
  | { type: 'project'; project: ProjectRecord }
  | { type: 'message'; seq: number; envelope: BoxEnvelope }
  | {
      type: 'commit'
      kind: string
      id: string
      seq: number
      deleted: boolean
      data: unknown
      /** Proposed: record metadata, so live updates show who wrote what. */
      author?: string
      version?: number
      updatedAt?: number
      source?: { messageId?: string; sessionEventId?: string; agentId?: string }
    }
  | { type: 'chunk'; agentId: string; text: string }
  | { type: 'agent-status'; agentId: string; status: 'idle' | 'running' }
  /** What an Agent is doing now, in a few words (from its latest tool call). */
  | { type: 'activity'; agentId: string; text: string }
  | { type: 'approval/request'; id: string; tool: string; input: string; via?: 'run_code' }
  | { type: 'heartbeat'; at: number }
