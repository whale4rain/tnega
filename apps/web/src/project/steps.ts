import type { DisplayPlan } from './reuse'
import type { BootEnvelope, ThreadRecord } from './types'

export type StepMark = 'done' | 'running' | 'pending' | 'failed'

export interface PlanStep {
  id: string
  title: string
  mark: StepMark
  detail?: string
}

/**
 * 把 plan 投影成结构化步骤：✓ 已完成、● 正在做、○ 还没开始。
 *
 * 「正在做」不写在数据里 —— plan 只记 pending，所以取第一个还没完成的条目当作当前步骤，
 * 前提是这一轮整体还在 running。
 */
export function planSteps(plan: DisplayPlan | undefined): PlanStep[] {
  if (!plan?.items.length) return []
  let runningTaken = false
  return plan.items.map(item => {
    let mark: StepMark = item.status === 'done' ? 'done' : item.status === 'failed' ? 'failed' : 'pending'
    if (mark === 'pending' && plan.status === 'running' && !runningTaken) {
      runningTaken = true
      mark = 'running'
    }
    return {
      id: item.id,
      title: item.title,
      mark,
      ...(item.detail ? { detail: item.detail } : {}),
    }
  })
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

/** 线程的当前状态；记录还没到就按空闲处理。 */
export function threadStateOf(threads: readonly ThreadRecord[], id: string): ThreadRecord['state'] {
  return threads.find(thread => thread.id === id)?.state ?? 'idle'
}

/** 步骤标记：✓ 已完成、● 正在做、✗ 失败、○ 还没开始。 */
export function markOf(mark: StepMark): string {
  switch (mark) {
    case 'done': return '✓'
    case 'running': return '●'
    case 'failed': return '✗'
    case 'pending': return '○'
  }
}
