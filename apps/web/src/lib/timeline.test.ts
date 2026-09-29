import { describe, expect, it } from 'vitest'
import { parseSseFrame } from './api'
import { applyStream, beginRun, fromEvents, type Entry } from './timeline'
import { presentTool, readableOutput } from './tools'
import type { SessionEvent, StreamEvent } from './types'

let seq = 0
function ev<T extends SessionEvent['type']>(type: T, payload: Extract<SessionEvent, { type: T }>['payload'], id = `e${++seq}`): SessionEvent {
  return { id, seq, ts: seq, type, payload } as SessionEvent
}

const SUB = '0f8f6c1e-3b0a-4a39-9d7e-7f1d2a3b4c5d'

describe('fromEvents', () => {
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
