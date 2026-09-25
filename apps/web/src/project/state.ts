import type {
  BootEnvelope,
  FactRecord,
  ProjectRecord,
  ProjectSnapshot,
  ProjectStreamEvent,
  ThreadRecord,
  ThreadState,
} from './types'

/**
 * Project 屏的全部状态。它是快照加事件流的纯函数结果 —— 没有从模型文本里猜出来的东西：
 * 消息来自 Box，卡片状态来自 Thread 记录，资料来自 Blackboard。
 */
export interface ProjectView {
  project: ProjectRecord
  coordinatorId: string
  /** 已见过的最后一条主对话消息的序号，重连时作为追赶游标。 */
  cursor: number
  threads: ThreadRecord[]
  messages: BootEnvelope[]
  memory: Array<FactRecord>
  artifacts: Array<FactRecord>
  resources: Array<FactRecord>
  approvals: Array<{ id: string; tool: string; input: string }>
}

function threadOf(data: Record<string, unknown>, id: string): ThreadRecord {
  const states: readonly ThreadState[] = ['working', 'waiting', 'blocked', 'idle', 'done', 'failed']
  const state = states.includes(data.state as ThreadState) ? data.state as ThreadState : 'idle'
  const permission = data.permission === 'bypass'
    ? 'bypass'
    : data.permission === 'workspace-write' ? 'workspace-write' : 'read-only'
  return {
    id,
    projectId: String(data.projectId ?? ''),
    label: String(data.label ?? id),
    goal: String(data.goal ?? ''),
    state,
    depth: Number(data.depth ?? 0),
    permission,
    createdAt: Number(data.createdAt ?? 0),
    updatedAt: Number(data.updatedAt ?? 0),
    ...(typeof data.parentId === 'string' ? { parentId: data.parentId } : {}),
    ...(typeof data.expect === 'string' ? { expect: data.expect } : {}),
    ...(typeof data.detail === 'string' ? { detail: data.detail } : {}),
  }
}

function upsertFact(list: Array<FactRecord>, fact: FactRecord): Array<FactRecord> {
  const without = list.filter(entry => entry.id !== fact.id)
  if (fact.deleted) return without
  return [...without, fact].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
}

export function fromSnapshot(snapshot: ProjectSnapshot): ProjectView {
  return {
    project: snapshot.project,
    coordinatorId: snapshot.coordinatorId,
    cursor: snapshot.cursor,
    threads: [...snapshot.threads].sort((a, b) => a.createdAt - b.createdAt),
    messages: [...snapshot.messages].sort((a, b) => a.createdAt - b.createdAt),
    memory: snapshot.memory,
    artifacts: snapshot.library.artifacts,
    resources: snapshot.library.resources,
    approvals: [],
  }
}

/** 把一条消息并进时间线。同一个 `messageId` 再来一次是空操作（幂等）。 */
export function mergeMessage(view: ProjectView, envelope: BootEnvelope): ProjectView {
  if (view.messages.some(entry => entry.messageId === envelope.messageId)) return view
  const messages = [...view.messages, envelope].sort((a, b) => a.createdAt - b.createdAt)
  return { ...view, messages }
}

/** 应用一个流事件。同一个事件重复到达是幂等的：消息按 `messageId` 去重，事实按版本覆盖。 */
export function applyStreamEvent(view: ProjectView, event: ProjectStreamEvent): ProjectView {
  if (event.type === 'heartbeat') return view
  // 正在生成的正文与运行状态是过程，不是持久事实：进不了这份投影，界面自己处理。
  if (event.type === 'chunk' || event.type === 'agent-status') return view
  if (event.type === 'approval/request') {
    if (view.approvals.some(entry => entry.id === event.id)) return view
    return { ...view, approvals: [...view.approvals, { id: event.id, tool: event.tool, input: event.input }] }
  }
  if (event.type === 'message') {
    const merged = mergeMessage(view, event.envelope)
    const cursor = Math.max(view.cursor, event.seq)
    // 重复的一帧（重连补投）原样返回同一个对象，避免无意义的重渲染。
    if (merged === view && cursor === view.cursor) return view
    return { ...merged, cursor }
  }
  const fact: FactRecord = {
    kind: event.kind,
    id: event.id,
    seq: event.seq,
    version: 0,
    data: event.data,
    author: '',
    source: {},
    createdAt: 0,
    updatedAt: Date.now(),
    deleted: event.deleted,
  }
  if (event.kind === 'agent') {
    if (event.deleted) {
      return { ...view, threads: view.threads.filter(thread => thread.id !== event.id) }
    }
    const next = threadOf(event.data, event.id)
    const threads = view.threads.some(thread => thread.id === next.id)
      ? view.threads.map(thread => (thread.id === next.id ? next : thread))
      : [...view.threads, next]
    return { ...view, threads: threads.sort((a, b) => a.createdAt - b.createdAt) }
  }
  if (event.kind === 'memory') return { ...view, memory: upsertFact(view.memory, fact) }
  if (event.kind === 'artifact') return { ...view, artifacts: upsertFact(view.artifacts, fact) }
  if (event.kind === 'resource') return { ...view, resources: upsertFact(view.resources, fact) }
  return view
}

export function threadStateLabel(state: ThreadState): string {
  switch (state) {
    case 'working': return 'Working'
    case 'waiting': return 'Waiting on you'
    case 'blocked': return 'Blocked'
    case 'idle': return 'Idle'
    case 'done': return 'Done'
    case 'failed': return 'Failed'
  }
}

export interface ThreadBuckets {
  /** 等用户处理：需要答复或授权。 */
  waiting: ThreadRecord[]
  working: ThreadRecord[]
  idle: ThreadRecord[]
  finished: ThreadRecord[]
}

/** Overview 的分组。等用户处理的排在最前 —— 那是用户唯一必须动手的地方。 */
export function threadBuckets(threads: readonly ThreadRecord[]): ThreadBuckets {
  const visible = threads.filter(thread => thread.depth > 0)
  return {
    waiting: visible.filter(thread => thread.state === 'waiting' || thread.state === 'blocked'),
    working: visible.filter(thread => thread.state === 'working'),
    idle: visible.filter(thread => thread.state === 'idle'),
    finished: visible.filter(thread => thread.state === 'done' || thread.state === 'failed'),
  }
}

export function coordinatorOf(view: ProjectView): ThreadRecord | undefined {
  return view.threads.find(thread => thread.id === view.coordinatorId)
}

export function childrenOf(view: ProjectView, threadId: string): ThreadRecord[] {
  return view.threads.filter(thread => thread.parentId === threadId)
}

/** 这个 Thread 自己的回复（主对话里不重复显示子 Thread 的每句话）。 */
export function threadReplies(
  messages: readonly BootEnvelope[],
  threadId: string,
): BootEnvelope[] {
  return messages.filter(envelope =>
    envelope.placement.kind === 'thread'
    && envelope.placement.threadId === threadId
    && envelope.kind === 'agent-reply')
}

export function pendingCount(view: ProjectView): number {
  const buckets = threadBuckets(view.threads)
  return buckets.waiting.length + view.approvals.length
}
