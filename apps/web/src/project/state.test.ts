import { describe, expect, it } from 'vitest'
import {
  applyStreamEvent,
  childrenOf,
  coordinatorOf,
  fromSnapshot,
  mergeMessage,
  pendingCount,
  threadBuckets,
} from './state'
import type { BootEnvelope, ProjectSnapshot, ThreadRecord } from './types'

const projectId = '22222222-2222-4222-8222-222222222222'
const coordinatorId = '11111111-1111-4111-8111-111111111111'
const childId = '33333333-3333-4333-8333-333333333333'

function thread(id: string, overrides: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    id,
    projectId,
    label: id === coordinatorId ? 'Notes' : 'Summarise section 2',
    goal: 'Track findings',
    state: 'idle',
    depth: id === coordinatorId ? 0 : 1,
    permission: 'workspace-write',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function envelope(overrides: Partial<BootEnvelope> = {}): BootEnvelope {
  return {
    messageId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    projectId,
    sender: { kind: 'user', id: 'user' },
    recipients: [{ kind: 'agent', id: coordinatorId }],
    placement: { kind: 'main' },
    kind: 'user-message',
    text: 'Summarise the release notes',
    refs: [],
    createdAt: 10,
    ...overrides,
  }
}

function snapshot(): ProjectSnapshot {
  return {
    project: {
      id: projectId,
      name: 'Notes',
      coordinatorId,
      createdAt: 1,
      updatedAt: 1,
    },
    coordinatorId,
    cursor: 4,
    threads: [thread(coordinatorId)],
    messages: [envelope()],
    inboxMessages: [],
    memory: [],
    library: { artifacts: [], resources: [] },
  }
}

describe('project view', () => {
  it('starts from the snapshot and keeps the cursor for reconnects', () => {
    const view = fromSnapshot(snapshot())
    expect(view.cursor).toBe(4)
    expect(view.messages.map(entry => entry.kind)).toEqual(['user-message'])
    expect(coordinatorOf(view)?.label).toBe('Notes')
  })

  it('appends messages once and advances the cursor', () => {
    const view = fromSnapshot(snapshot())
    const reply = envelope({
      messageId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      sender: { kind: 'agent', id: coordinatorId },
      kind: 'agent-reply',
      text: 'notes look good',
      createdAt: 20,
    })
    const next = applyStreamEvent(view, { type: 'message', seq: 9, envelope: reply })
    expect(next.cursor).toBe(9)
    expect(next.messages.map(entry => entry.text))
      .toEqual(['Summarise the release notes', 'notes look good'])
    // 同一帧重放是空操作 —— 重连补投不该画出两条。
    expect(applyStreamEvent(next, { type: 'message', seq: 9, envelope: reply })).toBe(next)
  })

  it('opens snapshots from servers that do not include inbox messages yet', () => {
    const legacySnapshot = snapshot()
    Reflect.deleteProperty(legacySnapshot, 'inboxMessages')

    expect(fromSnapshot(legacySnapshot).inboxMessages).toEqual([])
  })

  it('keeps child inbox messages out of the main conversation', () => {
    const view = fromSnapshot(snapshot())
    const reply = envelope({
      messageId: 'cccccccccccccccccccccccccccccccc',
      sender: { kind: 'agent', id: childId },
      recipients: [{ kind: 'agent', id: coordinatorId }],
      placement: { kind: 'thread', threadId: childId },
      kind: 'complete',
      text: 'Child result',
      createdAt: 20,
    })

    const next = applyStreamEvent(view, { type: 'message', seq: 9, envelope: reply })

    expect(next.messages.map(entry => entry.text)).toEqual(['Summarise the release notes'])
    expect(next.inboxMessages).toEqual([reply])
  })

  it('moves a thread card with the thread record, not with model text', () => {
    const view = fromSnapshot(snapshot())
    const spawned = applyStreamEvent(view, {
      type: 'commit',
      kind: 'agent',
      id: childId,
      seq: 6,
      deleted: false,
      data: {
        projectId,
        label: 'Summarise section 2',
        goal: 'Summarise section 2',
        state: 'working',
        depth: 1,
        permission: 'read-only',
        parentId: coordinatorId,
      },
    })
    expect(childrenOf(spawned, coordinatorId).map(entry => entry.id)).toEqual([childId])
    expect(threadBuckets(spawned.threads).working.map(entry => entry.id)).toEqual([childId])

    const settled = applyStreamEvent(spawned, {
      type: 'commit',
      kind: 'agent',
      id: childId,
      seq: 11,
      deleted: false,
      data: {
        projectId,
        label: 'Summarise section 2',
        goal: 'Summarise section 2',
        state: 'waiting',
        detail: 'Which release?',
        depth: 1,
        permission: 'read-only',
        parentId: coordinatorId,
      },
    })
    expect(threadBuckets(settled.threads).waiting.map(entry => entry.id)).toEqual([childId])
    expect(pendingCount(settled)).toBe(1)
    // 协调者本身不进 Overview 的分组：它是主对话，不是一件待办。
    expect(threadBuckets(settled.threads).idle).toEqual([])
  })

  it('versions memory and artifacts by id, honouring deletions', () => {
    const view = fromSnapshot(snapshot())
    const created = applyStreamEvent(view, {
      type: 'commit',
      kind: 'memory',
      id: '44444444-4444-4444-8444-444444444444',
      seq: 7,
      deleted: false,
      data: { text: 'Releases ship on Thursdays' },
    })
    expect(created.memory).toHaveLength(1)
    const updated = applyStreamEvent(created, {
      type: 'commit',
      kind: 'memory',
      id: '44444444-4444-4444-8444-444444444444',
      seq: 8,
      deleted: false,
      data: { text: 'Releases ship on Fridays' },
    })
    expect(updated.memory.map(entry => entry.data.text)).toEqual(['Releases ship on Fridays'])
    const deleted = applyStreamEvent(updated, {
      type: 'commit',
      kind: 'memory',
      id: '44444444-4444-4444-8444-444444444444',
      seq: 9,
      deleted: true,
      data: { text: 'Releases ship on Fridays' },
    })
    expect(deleted.memory).toEqual([])
  })

  it('shows a local echo of what the user just sent without double-counting it', () => {
    const view = fromSnapshot(snapshot())
    const echoed = mergeMessage(view, envelope({ messageId: 'cccccccccccccccccccccccccccccccc', text: 'and also this', createdAt: 30 }))
    expect(echoed.messages.map(entry => entry.text))
      .toEqual(['Summarise the release notes', 'and also this'])
    // 本地回显不算追赶游标：它还没有服务端序号。
    expect(echoed.cursor).toBe(view.cursor)
    // 流里那条按 messageId 去重。
    const same = applyStreamEvent(echoed, {
      type: 'message',
      seq: 12,
      envelope: envelope({ messageId: 'cccccccccccccccccccccccccccccccc', text: 'and also this', createdAt: 30 }),
    })
    expect(same.messages).toHaveLength(2)
    expect(same.cursor).toBe(12)
  })

  it('collects approval requests so the screen can surface them', () => {
    const view = fromSnapshot(snapshot())
    const asked = applyStreamEvent(view, {
      type: 'approval/request',
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      tool: 'shell',
      input: '{"command":"rm -rf build"}',
    })
    expect(pendingCount(asked)).toBe(1)
    expect(applyStreamEvent(asked, {
      type: 'approval/request',
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      tool: 'shell',
      input: '{"command":"rm -rf build"}',
    }).approvals).toHaveLength(1)
  })
})
