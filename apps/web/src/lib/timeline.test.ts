import { describe, expect, it } from 'vitest'
import { parseSseFrame } from './api'
import { applyStream, beginRun, fromEvents, presentRun, type Entry } from './timeline'
import { presentTool, readableOutput } from './tools'
import type { SessionEvent, StreamEvent } from './types'

let seq = 0
function ev<T extends SessionEvent['type']>(type: T, payload: Extract<SessionEvent, { type: T }>['payload'], id = `e${++seq}`): SessionEvent {
  return { id, seq, ts: seq, type, payload } as SessionEvent
}

const SUB = '0f8f6c1e-3b0a-4a39-9d7e-7f1d2a3b4c5d'

describe('fromEvents', () => {
  it('nests PTC dispatches below their outer tool without creating top-level tool messages', () => {
    const entries = fromEvents([
      ev('turn/start', { turn: 1 }),
      ev('tool/call', { id: 'outer', name: 'run_code', arguments: { code: 'await tools.shell({command:"cargo test"})' } }),
      ev('meta', { kind: 'ptc/dispatch-start', parentCallId: 'outer', callId: 'child', name: 'shell', input: { command: 'cargo test' } }),
      ev('meta', { kind: 'ptc/dispatch', parentCallId: 'outer', callId: 'child', name: 'shell', ok: false, result: { error: { message: 'Tests failed' }, durationMs: 42 } }),
      ev('tool/result', { id: 'outer-result', toolCallId: 'outer', name: 'run_code', ok: false }),
      ev('meta', { kind: 'ptc/dispatch-start', parentCallId: 'missing', callId: 'orphan', name: 'read_file', input: {} }),
    ])
    const entry = entries.find(item => item.kind === 'agent')
    if (!entry || entry.kind !== 'agent') throw new Error('Missing agent')
    expect(entry.blocks).toHaveLength(1)
    expect(entry.blocks[0]).toMatchObject({ kind: 'tool', tool: { callId: 'outer', children: [{ callId: 'child', name: 'shell', args: { command: 'cargo test' }, status: 'error', error: 'Tests failed', durationMs: 42 }] } })
  })
  it('hides successful automatic approval notices while preserving fallback reasons', () => {
    const entries = fromEvents([
      ev('turn/start', { turn: 1 }),
      ev('meta', { kind: 'approval/review', decision: 'allow', tool: 'shell', reason: 'Tests requested' }),
      ev('meta', { kind: 'approval/review', decision: 'ask', tool: 'http_get', reason: 'Destination uncertain' }),
      ev('assistant/message', { content: 'Done' }, 'answer'),
      ev('turn/end', { turn: 1, finishReason: 'stop' }),
    ])
    const entry = entries.find(item => item.kind === 'agent')
    if (!entry || entry.kind !== 'agent') throw new Error('Missing agent')
    const view = presentRun(entry)
    expect(entry.blocks).not.toContainEqual(expect.objectContaining({ text: expect.stringContaining('自动审批已通过') }))
    expect(view.visible).toContainEqual(expect.objectContaining({ text: '需要你确认：http_get — Destination uncertain' }))
  })
  it.each([
    ['low', 'Risk confidence 0.4 is below 0.85', '初步判断为低风险，但还不够确定，需要你确认。'],
    ['medium', 'Conflict probability 0.1 exceeds 0.05', '操作可能与你的要求或约束冲突，需要你确认。'],
    ['high', 'Risk confidence 0.4 is below 0.85', '初步判断为高风险，但还不够确定，需要你确认。'],
    ['low', 'Risk confidence 0.4 is below 0.85; Conflict probability 0.3 exceeds 0.2', '操作可能与你的要求或约束冲突，需要你确认。'],
    ['low', 'No human task is available', '缺少你的任务指示，需要你确认。'],
    [undefined, 'Automatic reviewer is unavailable; human review is required.', '自动审批暂不可用，需要你确认。'],
    [undefined, 'Automatic review was cancelled or timed out.', '自动审批已取消或超时，需要你确认。'],
  ])('explains automatic approval fallback without audit numbers (%s, %s)', (risk, reason, explanation) => {
    const payload = { kind: 'approval/review', decision: 'ask', tool: 'shell', risk, reason, scores: { riskConfidence: 0.4, conflict: 0.1 } }
    const entries = fromEvents([ev('meta', payload)])
    const entry = entries.find(item => item.kind === 'agent')
    if (!entry || entry.kind !== 'agent') throw new Error('Missing agent')
    expect(entry.blocks).toContainEqual(expect.objectContaining({ text: `需要你确认：shell — ${explanation}` }))
    expect(payload.reason).toBe(reason)
    expect(payload.scores).toEqual({ riskConfidence: 0.4, conflict: 0.1 })
  })
  it('keeps activity visible when a checkpoint separates it from the final reply', () => {
    const entries = fromEvents([
      ev('turn/start', { turn: 1 }),
      ev('assistant/message', { content: 'Final reply' }, 'answer'),
      ev('checkpoint', { summary: 'Compacted context' }),
      ev('tool/call', { id: 'late', name: 'read_file', arguments: {} }),
      ev('tool/result', { id: 'result', toolCallId: 'late', name: 'read_file', ok: true }),
      ev('turn/end', { turn: 1, finishReason: 'stop' }),
    ])
    const latest = [...entries].reverse().find(entry => entry.kind === 'agent')
    if (!latest || latest.kind !== 'agent') throw new Error('Missing agent')
    expect(presentRun(latest).process).toEqual([])
    expect(presentRun(latest).visible).toHaveLength(1)
  })

  it('keeps final reply, failed tools, notices and edited files outside the collapsed process', () => {
    const entries = fromEvents([
      ev('turn/start', { turn: 1 }),
      ev('assistant/message', { content: 'Working', toolCalls: [{ id: 'c', name: 'read_file', arguments: {} }] }),
      ev('tool/result', { id: 'r', toolCallId: 'c', name: 'read_file', ok: false, error: { message: 'Missing file', name: 'Error' } }),
      ev('llm/retry', { retryId: 'retry', retry: 1, delayMs: 0 }),
      ev('assistant/message', { content: 'Done' }, 'answer'),
      ev('turn/end', { turn: 1, finishReason: 'stop' }),
      ev('meta', { kind: 'files/edited', files: ['a.ts'] }),
    ])
    const entry = entries.find(entry => entry.kind === 'agent')
    if (!entry || entry.kind !== 'agent') throw new Error('Missing agent')
    // A missing file is feedback for the model, so it folds into the process.
    expect(presentRun(entry).process.map(block => block.kind)).toEqual(['text', 'tool'])
    expect(presentRun(entry).visible.map(block => block.kind)).toEqual(['notice', 'text', 'files'])
    expect(presentRun({ ...entry, status: 'running' }).process).toEqual([])
  })

  it('keeps tool failures a person must act on outside the collapsed process', () => {
    const entry = fromEvents([
      ev('turn/start', { turn: 1 }),
      ev('assistant/message', { content: 'Working', toolCalls: [{ id: 'c', name: 'shell', arguments: {} }] }),
      ev('tool/result', { id: 'r', toolCallId: 'c', name: 'shell', ok: false, error: { message: 'no sandbox', name: 'SandboxUnavailableError' } }),
      ev('assistant/message', { content: 'Done' }, 'answer'),
      ev('turn/end', { turn: 1, finishReason: 'stop' }),
    ]).find(entry => entry.kind === 'agent')
    if (!entry || entry.kind !== 'agent') throw new Error('Missing agent')
    expect(presentRun(entry).visible.map(block => block.kind)).toEqual(['tool', 'text'])
  })

  it('does not infer a final answer from a tool call or interrupted final assistant message', () => {
    for (const payload of [
      { content: 'Need tool', toolCalls: [{ id: 'c', name: 'read_file', arguments: {} }] },
      { content: 'Partial', interrupted: true },
    ]) {
      const entry = fromEvents([
        ev('turn/start', { turn: 1 }),
        ev('assistant/message', { content: 'Earlier answer' }),
        ev('assistant/message', payload),
        ev('turn/end', { turn: 1, finishReason: 'stop' }),
      ]).find(entry => entry.kind === 'agent')
      expect(entry).not.toHaveProperty('summary')
    }
  })

  it('separates completed Agent Runs without new user input and derives legacy final replies', () => {
    const entries = fromEvents([
      ev('turn/start', { turn: 1 }),
      ev('user/message', { content: 'Continue the goal' }),
      ev('assistant/message', { content: 'Checking', toolCalls: [{ id: 'c', name: 'read_file', arguments: {} }] }, 'a1'),
      ev('tool/result', { id: 'r', toolCallId: 'c', name: 'read_file', ok: true }),
      ev('assistant/message', { content: 'First result' }, 'a2'),
      ev('turn/end', { turn: 1, finishReason: 'stop' }),
      ev('meta', { kind: 'run/summary', turn: 1, summary: 'First result', sourceMessageId: 'a2' }),
      ev('turn/start', { turn: 2 }),
      ev('assistant/message', { content: 'Second result' }, 'a3'),
      ev('turn/end', { turn: 2, finishReason: 'stop' }),
    ])
    const agents = entries.filter(entry => entry.kind === 'agent')
    expect(agents).toHaveLength(2)
    expect(agents[0]).toMatchObject({ turn: 1, summary: { text: 'First result', sourceMessageId: 'a2' } })
    expect(agents[1]).toMatchObject({ turn: 2, summary: { text: 'Second result', sourceMessageId: 'a3' } })
  })

  it('never collapses open, cancelled, failed or capped runs, even with stale metadata', () => {
    for (const finishReason of ['cancelled', 'error', 'max_steps', 'length']) {
      const entries = fromEvents([
        ev('turn/start', { turn: 1 }),
        ev('assistant/message', { content: 'Partial' }, 'partial'),
        ev('turn/end', { turn: 1, finishReason }),
        ev('meta', { kind: 'run/summary', turn: 1, summary: 'Partial', sourceMessageId: 'partial' }),
      ])
      expect(entries.find(entry => entry.kind === 'agent')).not.toHaveProperty('summary')
    }
    expect(fromEvents([
      ev('turn/start', { turn: 1 }),
      ev('assistant/message', { content: 'Streaming' }),
    ]).find(entry => entry.kind === 'agent')).not.toHaveProperty('summary')
  })

  it('folds everything between user messages into one agent turn', () => {
    const entries = fromEvents([
      ev('user/message', { content: 'fix the bug' }, 'u1'),
      ev('assistant/message', { content: 'Looking.', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } }] }, 'a1'),
      ev('tool/call', { id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } }),
      ev('tool/result', { id: 'r1', toolCallId: 'c1', name: 'read_file', ok: true, output: 'code', durationMs: 12 }),
      ev('assistant/message', { content: 'Fixed.' }, 'a2'),
      ev('user/message', { content: 'thanks' }, 'u2'),
    ])
    expect(entries.map(e => e.kind)).toEqual(['user', 'agent', 'user'])
    const agent = entries[1] as Extract<Entry, { kind: 'agent' }>
    expect(agent.blocks.map(b => b.kind)).toEqual(['text', 'tool', 'text'])
    expect(agent.forkId).toBe('a2')
    const tool = agent.blocks[1]
    expect(tool?.kind === 'tool' && tool.tool).toMatchObject({ status: 'ok', output: 'code', durationMs: 12 })
  })

  it('ignores system prompts and hidden bookkeeping', () => {
    const entries = fromEvents([
      ev('system/message', { content: 'you are a coding agent' }),
      ev('other', {}),
      ev('user/message', { content: 'hi' }),
    ])
    expect(entries).toHaveLength(1)
  })

  it('attaches subagent replies to their card instead of showing them as user messages', () => {
    const entries = fromEvents([
      ev('user/message', { content: 'research' }),
      ev('tool/call', { id: 's1', name: 'spawn_subagent', arguments: { task: 'look into X', label: 'Researcher' } }),
      ev('tool/result', { id: 'r', toolCallId: 's1', name: 'spawn_subagent', ok: true, output: `Started subagent ${SUB}` }),
      ev('user/message', { content: 'partial finding', name: `agent:${SUB}` }),
      ev('user/message', { content: `Subagent ${SUB} completed: final answer` }),
    ])
    expect(entries.map(e => e.kind)).toEqual(['user', 'agent'])
    const block = (entries[1] as Extract<Entry, { kind: 'agent' }>).blocks[0]
    expect(block?.kind).toBe('subagent')
    if (block?.kind !== 'subagent') return
    expect(block.agent).toMatchObject({ id: SUB, label: 'Researcher', status: 'ready', replies: ['partial finding', 'final answer'] })
  })

  it('marks cancelled turns and renders checkpoints, edits and slash results', () => {
    const entries = fromEvents([
      ev('user/message', { content: 'go' }),
      ev('assistant/message', { content: 'Start' }),
      ev('turn/end', { turn: 1, interrupted: true, cancelCause: { type: 'user' } }),
      ev('meta', { kind: 'files/edited', files: [{ path: 'src/a.ts', additions: 3, deletions: 1 }] }),
      ev('checkpoint', { summary: 'earlier work', tokensBefore: 1200 }),
      ev('meta', { kind: 'slash', command: '/skills', args: [], result: { kind: 'text', text: 'none' } }),
    ])
    const agent = entries[1] as Extract<Entry, { kind: 'agent' }>
    expect(agent.status).toBe('stopped')
    expect(agent.blocks.map(b => b.kind)).toEqual(['text', 'notice', 'files'])
    expect(entries[2]).toMatchObject({ kind: 'compaction', tokensBefore: 1200 })
    expect(entries[3]).toMatchObject({ kind: 'slash', command: '/skills' })
  })
})

describe('applyStream', () => {
  const run = (events: StreamEvent[]) => events.reduce(applyStream, beginRun([], 'hello', 1) as readonly Entry[])

  it('shows automatic compaction immediately and continues streaming without duplicate markers', () => {
    const frame = parseSseFrame('data: {"type":"session/compaction","id":"checkpoint-1","summary":"Earlier work","tokensBefore":12000}')
    if (!frame) throw new Error('Missing compaction frame')
    const initial = beginRun([], 'Continue', 1)
    const compacted = applyStream(initial, frame)
    expect(compacted.map(entry => entry.kind)).toEqual(['user', 'compaction', 'agent'])
    expect(compacted[1]).toEqual({ kind: 'compaction', id: 'checkpoint-1', summary: 'Earlier work', tokensBefore: 12000 })
    expect(applyStream(compacted, frame)).toBe(compacted)
    const streamed = applyStream(applyStream(compacted, { type: 'message_start', id: 'after' }), { type: 'message_delta', id: 'after', delta: 'Continuing' })
    expect(streamed.at(-1)).toMatchObject({ kind: 'agent', status: 'running', blocks: [{ text: 'Continuing' }] })
  })

  it('streams text deltas into a single block and settles it on stop', () => {
    const entries = run([
      { type: 'message_start', id: 'm1' },
      { type: 'message_delta', id: 'm1', delta: 'Hel' },
      { type: 'message_delta', id: 'm1', delta: 'lo' },
      { type: 'message_stop', id: 'm1', finishReason: 'stop' },
      { type: 'done' },
    ])
    const agent = entries[1] as Extract<Entry, { kind: 'agent' }>
    expect(agent.status).toBe('done')
    expect(agent.blocks).toEqual([{ kind: 'text', id: 'live-m1', text: 'Hello', streaming: false }])
  })

  it('drops empty text blocks from tool-only model responses', () => {
    const entries = run([
      { type: 'message_start', id: 'm1' },
      { type: 'message_stop', id: 'm1', finishReason: 'tool_calls' },
      { type: 'tool/start', index: 0, call: { id: 'c1', name: 'shell', arguments: { command: 'ls' } } },
      { type: 'tool/end', index: 0, call: { id: 'c1', name: 'shell', arguments: { command: 'ls' } }, result: { callId: 'c1', name: 'shell', ok: false, error: { message: 'denied' } } },
    ])
    const agent = entries[1] as Extract<Entry, { kind: 'agent' }>
    expect(agent.blocks).toHaveLength(1)
    expect(agent.blocks[0]).toMatchObject({ kind: 'tool', tool: { status: 'error', error: 'denied' } })
  })

  it('surfaces stream errors on the running turn', () => {
    const entries = run([{ type: 'error', message: 'API key is not configured' }])
    const agent = entries[1] as Extract<Entry, { kind: 'agent' }>
    expect(agent.status).toBe('error')
    expect(agent.blocks[0]).toMatchObject({ kind: 'notice', tone: 'error', text: 'API key is not configured' })
  })

  it('returns the same array for events it does not care about', () => {
    const start = beginRun([], 'x', 1)
    expect(applyStream(start, { type: 'assistant/stream' })).toBe(start)
  })
})

describe('parseSseFrame', () => {
  it('uses the event line as the type', () => {
    expect(parseSseFrame('event: done\ndata: {"type":"done"}')).toEqual({ type: 'done' })
    expect(parseSseFrame('event: tool/start\ndata: {"index":0}')).toEqual({ type: 'tool/start', index: 0 })
  })

  it('ignores comments and malformed data', () => {
    expect(parseSseFrame(': keepalive')).toBeUndefined()
    expect(parseSseFrame('data: {oops')).toBeUndefined()
  })
})

describe('tool presentation', () => {
  it('summarizes common tools with a verb and target', () => {
    expect(presentTool({ callId: '1', name: 'shell', args: { command: 'pnpm test\nmore' }, status: 'running' }))
      .toEqual({ family: 'shell', verb: 'Running', target: 'pnpm test' })
    expect(presentTool({ callId: '2', name: 'custom_thing', args: { path: 'x' }, status: 'ok' }))
      .toEqual({ family: 'other', verb: 'Custom thing', target: 'x' })
  })

  it('pulls stdout and stderr out of shell results', () => {
    expect(readableOutput({ stdout: 'ok\n', stderr: 'warn\n', exitCode: 1 }).text).toBe('ok\nwarn\nexit code 1')
    expect(readableOutput('{"a":1}')).toEqual({ text: '{\n  "a": 1\n}', language: 'json' })
    expect(readableOutput({ path: 'a.ts', bytes: 3, content: 'abc', truncated: false }).text).toBe('abc')
    expect(readableOutput([{ name: 'src', path: 'src', type: 'directory' }, { name: 'a.ts', path: 'src/a.ts', type: 'file' }]).text)
      .toBe('▸ src/\n  src/a.ts')
  })
})


it('renders nested PTC stream calls immediately and preserves prior immutable snapshots', () => {
  const initial = applyStream(beginRun([], 'Run tests'), { type: 'tool/start', index: 0, call: { id: 'outer', name: 'run_code', arguments: { code: 'await tools.shell({})' } } })
  const started = applyStream(initial, { type: 'ptc/dispatch', payload: { kind: 'ptc/dispatch-start', parentCallId: 'outer', callId: 'child', name: 'shell', input: { command: 'cargo test' } } })
  const finished = applyStream(started, { type: 'ptc/dispatch', payload: { kind: 'ptc/dispatch', parentCallId: 'outer', callId: 'child', name: 'shell', ok: true, result: { output: 'passed', durationMs: 12 } } })
  const original = initial.at(-1)
  if (original?.kind !== 'agent' || original.blocks[0]?.kind !== 'tool') throw new Error('Missing outer call')
  expect(original.blocks[0].tool.children).toBeUndefined()
  expect(started.at(-1)).toMatchObject({ blocks: [{ tool: { children: [{ name: 'shell', status: 'running' }] } }] })
  expect(finished.at(-1)).toMatchObject({ blocks: [{ tool: { children: [{ name: 'shell', status: 'ok', output: 'passed', durationMs: 12 }] } }] })
})

describe('image attachments', () => {
  const image = { type: 'image' as const, mediaType: 'image/png' as const, data: 'aW1n' }

  it('shows user images, including an image-only message, and tool screenshots', () => {
    const entries = fromEvents([
      ev('user/message', { content: '', attachments: [image] }),
      ev('turn/start', { turn: 1 }),
      ev('tool/call', { id: 'shot', name: 'browser_screenshot', arguments: {} }),
      ev('tool/result', { id: 'shot-result', toolCallId: 'shot', name: 'browser_screenshot', ok: true, output: 'captured', attachments: [image] }),
    ])
    expect(entries[0]).toMatchObject({ kind: 'user', text: '', images: [image] })
    const agent = entries.find(item => item.kind === 'agent')
    if (!agent || agent.kind !== 'agent') throw new Error('Missing agent')
    expect(agent.blocks[0]).toMatchObject({ kind: 'tool', tool: { images: [image], status: 'ok' } })
  })

  it('keeps images on the optimistic user entry and live tool results', () => {
    const started = beginRun([], 'look', 1, [image])
    expect(started[0]).toMatchObject({ kind: 'user', text: 'look', images: [image] })
    const running = applyStream(started, { type: 'tool/start', index: 0, call: { id: 'c', name: 'browser_screenshot', arguments: {} } } as StreamEvent)
    const settled = applyStream(running, {
      type: 'tool/end', index: 0, call: { id: 'c', name: 'browser_screenshot', arguments: {} },
      result: { callId: 'c', name: 'browser_screenshot', ok: true, output: 'ok', attachments: [image] },
    })
    const agent = settled.at(-1)
    if (!agent || agent.kind !== 'agent') throw new Error('Missing agent')
    expect(agent.blocks[0]).toMatchObject({ kind: 'tool', tool: { images: [image] } })
  })
})
