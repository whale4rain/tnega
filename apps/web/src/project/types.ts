/** Project 的线上形状：与 `packages/cli/src/project-host.ts` 的返回一一对应。 */

import type { SessionEvent } from '../types'

export type { SessionEvent }

export interface ProjectRecord {
  id: string
  name: string
  goal?: string
  coordinatorId: string
  repo?: { path: string; branch?: string }
  createdAt: number
  updatedAt: number
}

export type ThreadState = 'working' | 'waiting' | 'blocked' | 'idle' | 'done' | 'failed'

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
  permission: 'read-only' | 'workspace-write' | 'bypass'
  createdAt: number
  updatedAt: number
}

export type BoxAddress = { kind: 'user'; id: 'user' } | { kind: 'agent'; id: string }

export type BoxPlacement = { kind: 'main' } | { kind: 'thread'; threadId: string }

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

export interface BootEnvelope {
  messageId: string
  projectId: string
  sender: BoxAddress
  recipients: BoxAddress[]
  placement: BoxPlacement
  kind: BoxMessageKind
  text: string
  refs: Array<{ hash: string; size: number; mediaType: string }>
  threadId?: string
  causationId?: string
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

export interface ProjectSnapshot {
  project: ProjectRecord
  coordinatorId: string
  cursor: number
  threads: ThreadRecord[]
  messages: BootEnvelope[]
  /** 子 Agent 发给 coordinator 的 Box inbox 消息；主时间线中显示为 Subagent 卡片。 */
  inboxMessages?: BootEnvelope[]
  memory: Array<FactRecord>
  library: { artifacts: Array<FactRecord>; resources: Array<FactRecord> }
}

export interface ThreadDetail {
  thread: ThreadRecord
  /** 该 Agent 自己的 Session 事件；Thread 面板用它还原执行记录。 */
  events: SessionEvent[]
}

/** `GET /api/projects/:id/stream` 推下来的事件。 */
export type ProjectStreamEvent =
  | { type: 'message'; seq: number; envelope: BootEnvelope }
  | {
    type: 'commit'
    kind: string
    id: string
    seq: number
    deleted: boolean
    data: Record<string, unknown>
  }
  /** Agent 正在生成的正文，按块推；整轮结束后由 message 帧取代。 */
  | { type: 'chunk'; agentId: string; text: string }
  | { type: 'agent-status'; agentId: string; status: 'idle' | 'running' }
  | { type: 'approval/request'; id: string; tool: string; input: string }
  | { type: 'heartbeat'; at: number }
