import { describe, expect, it } from 'vitest'
import { artifactsFor, board, exchangeMessages, fromSnapshot, isUnread, latestReport, mainTimeline, projectWeather, reduceProject, threadActivity, threadState, threadStatusLine, today } from './project-model'
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
  it('restores both directions of an Agent exchange without leaking user chat or other pairs', () => {
    const dispatch = envelope({ kind: 'dispatch', sender: { kind: 'agent', id: COORD }, recipients: [{ kind: 'agent', id: T1 }], threadId: T1, text: 'Fix parser' })
    const report = envelope({ kind: 'progress', sender: { kind: 'agent', id: T1 }, recipients: [{ kind: 'agent', id: COORD }], placement: { kind: 'thread', threadId: T1 }, text: 'Found cause' })
    const nested = envelope({ kind: 'dispatch', sender: { kind: 'agent', id: T1 }, recipients: [{ kind: 'agent', id: T2 }], placement: { kind: 'thread', threadId: T2 }, text: 'Check output' })
    const user = envelope({ kind: 'user-thread', sender: { kind: 'user', id: 'user' }, recipients: [{ kind: 'agent', id: T1 }], placement: { kind: 'thread', threadId: T1 }, text: 'Private direct note' })
    let state = fromSnapshot(snapshot({ messages: [dispatch], inboxMessages: [report], agentMessages: [nested, report, dispatch], threadMessages: [user] }))
    expect(exchangeMessages(state, COORD, T1).map(m => m.text)).toEqual(['Fix parser', 'Found cause'])
    expect(exchangeMessages(state, T1, T2).map(m => m.text)).toEqual(['Check output'])
    // One stack of thread links: the coordinator never appears as a thread.
    expect(mainTimeline(state).filter(item => item.kind === 'threads')).toEqual([
      expect.objectContaining({ threadIds: [T1, T2] }),
    ])
    state = reduceProject(state, { type: 'message', seq: 10, envelope: report })
    expect(exchangeMessages(state, COORD, T1)).toHaveLength(2)
  })
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

  it('links each thread once, where it first came up', () => {
    const state = fromSnapshot(snapshot({
      threads: [thread(COORD, { depth: 0 }), thread(T1)],
      messages: [
        envelope({ kind: 'dispatch', sender: { kind: 'agent', id: COORD }, recipients: [{ kind: 'agent', id: T1 }] }),
        envelope({ kind: 'agent-reply', sender: { kind: 'agent', id: COORD }, text: 'Started.' }),
      ],
      agentMessages: [
        envelope({ kind: 'request', sender: { kind: 'agent', id: T1 }, recipients: [{ kind: 'agent', id: COORD }], placement: { kind: 'thread', threadId: T1 }, createdAt: 10 ** 9 }),
      ],
    }))
    expect(mainTimeline(state).map(item => item.kind)).toEqual(['threads', 'coordinator'])
  })

  it('keeps raw model chunks out of chat until an explicit reply is published', () => {
    let state = fromSnapshot(snapshot())
    state = reduceProject(state, { type: 'agent-status', agentId: COORD, status: 'running' })
    state = reduceProject(state, { type: 'chunk', agentId: COORD, text: 'Work' })
    state = reduceProject(state, { type: 'chunk', agentId: COORD, text: 'ing on it' })
    expect(mainTimeline(state)).toEqual([])
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

  it('says what a working thread without a checklist is doing, until its run ends', () => {
    let state = fromSnapshot(snapshot({ threads: [thread(COORD, { depth: 0 }), thread(T1, { state: 'working' })] }))
    expect(threadStatusLine(state, state.threads[T1]!).step).toBeUndefined()
    state = reduceProject(state, { type: 'activity', agentId: T1, text: 'Editing count.mjs' })
    expect(threadStatusLine(state, state.threads[T1]!).step).toBe('Editing count.mjs')
    state = reduceProject(state, { type: 'agent-status', agentId: T1, status: 'idle' })
    expect(state.activity[T1]).toBeUndefined()
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
    const lanes = board(state, {})
    expect(lanes.find(lane => lane.key === 'needs')?.threads.map(t => t.id)).toEqual([T1])
    expect(lanes.find(lane => lane.key === 'ready')?.threads.map(t => t.id)).toEqual([T2])
    expect(threadActivity(state, state.threads[T2]!)).toBe('All done')
  })

  it('never lists the coordinator as a worker thread', () => {
    const state = fromSnapshot(snapshot())
    expect(board(state, {}).every(lane => lane.threads.length === 0)).toBe(true)
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

describe('a calm main conversation', () => {
  it('keeps notices about thread messages out of the main conversation', () => {
    const state = fromSnapshot(snapshot({
      threads: [thread(COORD, { depth: 0 }), thread(T1)],
      messages: [
        envelope({ kind: 'dispatch', sender: { kind: 'agent', id: COORD }, threadId: T1 }),
        envelope({ kind: 'notice', sender: { kind: 'user', id: 'user' }, threadId: T1, text: 'The user wrote in thread "t1" (x): hi' }),
      ],
    }))
    expect(mainTimeline(state).map(item => item.kind)).toEqual(['threads'])
  })

  it('attaches published artifacts to the coordinator message that carries them', () => {
    const hash = 'a'.repeat(64)
    const artifact = { kind: 'artifact', id: hash, seq: 1, version: 1, data: { title: 'Plan', hash, size: 10, mediaType: 'text/html' }, author: COORD, source: {}, createdAt: 1, updatedAt: 1, deleted: false }
    const state = fromSnapshot(snapshot({
      library: { artifacts: [artifact], resources: [] },
      messages: [envelope({ kind: 'agent-reply', sender: { kind: 'agent', id: COORD }, text: '', refs: [{ hash, size: 10, mediaType: 'text/html' }] })],
    }))
    const [item] = mainTimeline(state)
    expect(item).toMatchObject({ kind: 'coordinator' })
    expect(item?.kind === 'coordinator' && artifactsFor(state, item.refs).map(a => a.data.title)).toEqual(['Plan'])
  })
})

describe('thread status', () => {
  it('shows the active checklist step while a thread works', () => {
    const working = thread(T1, { state: 'working', checklist: [{ title: 'Read the spec', status: 'done' }, { title: 'Run the tests', status: 'active' }] })
    const state = fromSnapshot(snapshot({ threads: [thread(COORD, { depth: 0 }), working] }))
    expect(threadStatusLine(state, working)).toMatchObject({ label: 'Working', step: 'Run the tests' })
    const done = { ...working, state: 'done' as const }
    const settled = fromSnapshot(snapshot({ threads: [thread(COORD, { depth: 0 }), done] }))
    expect(threadStatusLine(settled, done)).toEqual({ label: 'Done', tone: 'done' })
  })

  it('marks a settled thread unread until the user opens it', () => {
    const done = thread(T1, { state: 'done', updatedAt: 50 })
    const state = fromSnapshot(snapshot({ threads: [thread(COORD, { depth: 0 }), done] }))
    expect(isUnread(state, done, {})).toBe(true)
    expect(isUnread(state, done, { [T1]: 50 })).toBe(false)
    expect(isUnread(state, thread(T2, { state: 'working', updatedAt: 60 }), {})).toBe(false)
  })
})

describe('the Board', () => {
  it('moves a reported thread from Ready to Idle once seen, and folds resolved ones away', () => {
    const done = thread(T1, { state: 'done', updatedAt: 50 })
    const resolved = thread(T2, { state: 'resolved', updatedAt: 60 })
    const state = fromSnapshot(snapshot({ threads: [thread(COORD, { depth: 0 }), done, resolved] }))
    const lane = (seen: Record<string, number>, key: string) => board(state, seen).find(column => column.key === key)?.threads.map(t => t.id)
    expect(lane({}, 'ready')).toEqual([T1])
    expect(lane({ [T1]: 50 }, 'idle')).toEqual([T1])
    expect(lane({}, 'resolved')).toEqual([T2])
    expect(isUnread(state, resolved, {})).toBe(false)
  })

  it('reads the project weather from its most urgent thread', () => {
    const base = [thread(COORD, { depth: 0 })]
    expect(projectWeather(fromSnapshot(snapshot({ threads: base })))).toBe('clear')
    expect(projectWeather(fromSnapshot(snapshot({ threads: [...base, thread(T1, { state: 'working' })] })))).toBe('drizzle')
    expect(projectWeather(fromSnapshot(snapshot({ threads: [...base, thread(T1, { state: 'working' }), thread(T2, { state: 'working' })] })))).toBe('rain')
    expect(projectWeather(fromSnapshot(snapshot({ threads: [...base, thread(T1, { state: 'working' }), thread(T2, { state: 'waiting' })] })))).toBe('snow')
    expect(projectWeather(fromSnapshot(snapshot({ threads: [...base, thread(T1, { state: 'failed' }), thread(T2, { state: 'waiting' })] })))).toBe('storm')
  })

  it('counts today from midnight', () => {
    const now = new Date(2026, 9, 4, 15, 0).getTime()
    const morning = new Date(2026, 9, 4, 9, 0).getTime()
    const yesterday = new Date(2026, 9, 3, 23, 0).getTime()
    const state = fromSnapshot(snapshot({
      threads: [thread(COORD, { depth: 0 }), thread(T1, { createdAt: morning, updatedAt: morning, state: 'done' }), thread(T2, { createdAt: yesterday, updatedAt: yesterday, state: 'done' })],
    }))
    expect(today(state, now)).toEqual({ started: 1, finished: 1, artifacts: 0 })
    const usage = { total: { responses: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0 }, since: { responses: 2, promptTokens: 900, completionTokens: 100, cachedTokens: 0 }, byThread: [] }
    expect(today(state, now, usage).tokens).toBe(1000)
  })
})
