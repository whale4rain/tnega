import { describe, expect, it } from 'vitest'
import { fromSnapshot, latestReport, mainTimeline, overview, reduceProject, threadState } from './project-model'
import type { BoxEnvelope, ProjectSnapshot, ThreadRecord } from './project-types'

const COORD = 'c0000000-0000-4000-8000-000000000000'
const T1 = 't1000000-0000-4000-8000-000000000000'
const T2 = 't2000000-0000-4000-8000-000000000000'

let clock = 1000
function envelope(partial: Partial<BoxEnvelope> & Pick<BoxEnvelope, 'kind' | 'sender'>): BoxEnvelope {
  clock += 1
  return {
    messageId: `m${clock}`,
    projectId: 'p',
    recipients: [{ kind: 'user', id: 'user' }],
    placement: { kind: 'main' },
    text: '',
    refs: [],
    createdAt: clock,
    ...partial,
  }
}

function thread(id: string, patch: Partial<ThreadRecord> = {}): ThreadRecord {
  return { id, projectId: 'p', parentId: COORD, label: id.slice(0, 2), goal: 'do it', state: 'idle', depth: 1, permission: 'workspace-write', createdAt: 1, updatedAt: 1, ...patch }
}

function snapshot(partial: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    project: { id: 'p', name: 'Launch', coordinatorId: COORD, createdAt: 1, updatedAt: 1 },
    coordinatorId: COORD,
    cursor: 0,
    threads: [thread(COORD, { parentId: undefined, depth: 0, label: 'Launch' })] as ThreadRecord[],
    messages: [],
    inboxMessages: [],
    memory: [],
    library: { artifacts: [], resources: [] },
    ...partial,
  }
}

describe('mainTimeline', () => {
  it('groups consecutive dispatches into one card stack under the coordinator turn', () => {
    const state = fromSnapshot(snapshot({
      threads: [thread(COORD, { depth: 0 }), thread(T1), thread(T2)],
      messages: [
        envelope({ kind: 'user-message', sender: { kind: 'user', id: 'user' }, text: 'ship it' }),
        envelope({ kind: 'dispatch', sender: { kind: 'agent', id: COORD }, threadId: T1 }),
        envelope({ kind: 'dispatch', sender: { kind: 'agent', id: COORD }, threadId: T2 }),
        envelope({ kind: 'agent-reply', sender: { kind: 'agent', id: COORD }, text: 'Both running.' }),
      ],
    }))
    expect(mainTimeline(state).map(item => item.kind)).toEqual(['user', 'threads', 'coordinator'])
    expect(mainTimeline(state)[1]).toMatchObject({ threadIds: [T1, T2] })
  })

  it('shows the coordinator draft while it streams and drops it once the reply is published', () => {
    let state = fromSnapshot(snapshot())
    state = reduceProject(state, { type: 'agent-status', agentId: COORD, status: 'running' })
    state = reduceProject(state, { type: 'chunk', agentId: COORD, text: 'Work' })
    state = reduceProject(state, { type: 'chunk', agentId: COORD, text: 'ing on it' })
    expect(mainTimeline(state).at(-1)).toEqual({ kind: 'draft', id: 'coordinator-draft', text: 'Working on it' })
    state = reduceProject(state, {
      type: 'message',
      seq: 5,
      envelope: envelope({ kind: 'agent-reply', sender: { kind: 'agent', id: COORD }, text: 'Working on it' }),
    })
    expect(mainTimeline(state).map(item => item.kind)).toEqual(['coordinator'])
    expect(state.cursor).toBe(5)
  })

  it('ignores a message it has already seen (optimistic send, then stream echo)', () => {
    const sent = envelope({ kind: 'user-message', sender: { kind: 'user', id: 'user' }, text: 'hi' })
    let state = fromSnapshot(snapshot())
    state = reduceProject(state, { type: 'message', seq: 0, envelope: sent })
    state = reduceProject(state, { type: 'message', seq: 3, envelope: sent })
    expect(state.messages).toHaveLength(1)
  })
})

describe('threads', () => {
  it('tracks thread records from commits and live status from agent events', () => {
    let state = fromSnapshot(snapshot())
    const data: Partial<ThreadRecord> = thread(T1, { state: 'working' })
    delete data.id
    state = reduceProject(state, { type: 'commit', kind: 'agent', id: T1, seq: 2, deleted: false, data })
    expect(state.threads[T1]?.label).toBe('t1')
    state = reduceProject(state, { type: 'agent-status', agentId: T1, status: 'idle' })
    expect(threadState(state, state.threads[T1]!)).toBe('idle')
  })

  it('keeps the latest report per thread and puts threads that need attention first', () => {
    let state = fromSnapshot(snapshot({ threads: [thread(COORD, { depth: 0 }), thread(T1, { state: 'blocked' }), thread(T2, { state: 'done' })] }))
    const report = envelope({
      kind: 'complete',
      sender: { kind: 'agent', id: T2 },
      recipients: [{ kind: 'agent', id: COORD }],
      placement: { kind: 'thread', threadId: T2 },
      text: 'All done',
    })
    state = reduceProject(state, { type: 'message', seq: 9, envelope: report })
    expect(latestReport(state, T2)?.text).toBe('All done')
    expect(state.messages).toHaveLength(0)
    expect(overview(state).map(group => group.key)).toEqual(['attention', 'finished'])
  })

  it('never lists the coordinator as a worker thread', () => {
    const state = fromSnapshot(snapshot())
    expect(overview(state)).toEqual([])
  })
})

describe('memory and library', () => {
  it('adds, updates and removes memory from commits', () => {
    let state = fromSnapshot(snapshot())
    state = reduceProject(state, { type: 'commit', kind: 'memory', id: 'm1', seq: 1, deleted: false, data: { text: 'Launch Friday' } })
    state = reduceProject(state, { type: 'commit', kind: 'memory', id: 'm1', seq: 2, deleted: false, data: { text: 'Launch Monday' } })
    expect(state.memory.map(m => m.data.text)).toEqual(['Launch Monday'])
    state = reduceProject(state, { type: 'commit', kind: 'memory', id: 'm1', seq: 3, deleted: true, data: { text: 'Launch Monday' } })
    expect(state.memory).toEqual([])
  })

  it('collects published artifacts', () => {
    const state = reduceProject(fromSnapshot(snapshot()), {
      type: 'commit', kind: 'artifact', id: 'abc', seq: 4, deleted: false, data: { title: 'Notes', hash: 'abc', size: 10, mediaType: 'text/markdown' },
    })
    expect(state.artifacts[0]?.data.title).toBe('Notes')
  })
})

describe('replies', () => {
  it('links a coordinator reply to the thread report it answers', () => {
    const report = envelope({
      kind: 'complete',
      sender: { kind: 'agent', id: T1 },
      recipients: [{ kind: 'agent', id: COORD }],
      placement: { kind: 'thread', threadId: T1 },
      text: 'Found **one** bug',
    })
    const state = fromSnapshot(snapshot({
      threads: [thread(COORD, { depth: 0 }), thread(T1, { label: 'Audit' })],
      messages: [
        envelope({ kind: 'user-message', sender: { kind: 'user', id: 'user' }, text: 'go' }),
        envelope({ kind: 'agent-reply', sender: { kind: 'agent', id: COORD }, text: 'Noted', causationId: report.messageId }),
      ],
      inboxMessages: [report],
    }))
    const reply = mainTimeline(state)[1]
    expect(reply?.kind === 'coordinator' && reply.replyTo).toEqual([
      { id: report.messageId, who: 'thread', label: 'Audit', agentId: T1, threadId: T1, excerpt: 'Found one bug', inMain: false },
    ])
  })

  it('omits the link when a reply answers the message right above it', () => {
    const ask = envelope({ kind: 'user-message', sender: { kind: 'user', id: 'user' }, text: 'hi' })
    const state = fromSnapshot(snapshot({
      messages: [ask, envelope({ kind: 'agent-reply', sender: { kind: 'agent', id: COORD }, text: 'hello', causationId: ask.messageId })],
    }))
    const reply = mainTimeline(state)[1]
    expect(reply?.kind === 'coordinator' && reply.replyTo).toEqual([])
  })

  it('restores reply links the user chose from local storage', () => {
    const answer = envelope({ kind: 'agent-reply', sender: { kind: 'agent', id: COORD }, text: 'Plan A or B?' })
    const other = envelope({ kind: 'agent-reply', sender: { kind: 'agent', id: COORD }, text: 'Also, B is cheaper.' })
    const mine = envelope({ kind: 'user-message', sender: { kind: 'user', id: 'user' }, text: 'A' })
    const state = fromSnapshot(snapshot({ messages: [answer, other, mine] }), { [mine.messageId]: answer.messageId })
    const item = mainTimeline(state)[2]
    expect(item?.kind === 'user' && item.replyTo.map(r => [r.who, r.excerpt])).toEqual([['coordinator', 'Plan A or B?']])
  })
})
