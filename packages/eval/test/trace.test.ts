import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { deriveTraceMetrics, readTrace } from '../src/trace.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('trace metrics', () => {
  it('reads a session jsonl file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tnega-trace-'))
    dirs.push(dir)
    const file = join(dir, 'session.jsonl')
    await writeFile(file, `${JSON.stringify({ type: 'turn/start', payload: {} })}\n`, 'utf8')
    const events = await readTrace(file)
    expect(events[0]?.type).toBe('turn/start')
  })

  it('derives tool, retry and recovery metrics', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tnega-trace-'))
    dirs.push(dir)
    const file = join(dir, 'session.jsonl')
    const events = [
      { id: '1', seq: 1, ts: 1, type: 'turn/start', payload: {} },
      { id: '2', seq: 2, ts: 2, type: 'tool/call', payload: { name: 'read_file', id: 'a', input: {} } },
      { id: '3', seq: 3, ts: 3, type: 'tool/result', payload: { ok: false, name: 'read_file', id: 'a', input: {}, startedAt: 2, durationMs: 1, error: { name: 'ToolInputError', message: 'bad' } } },
      { id: '4', seq: 4, ts: 4, type: 'llm/retry-started', payload: { attempt: 1 } },
      { id: '5', seq: 5, ts: 5, type: 'tool/call', payload: { name: 'shell', id: 'b', input: { command: 'pytest' } } },
      { id: '6', seq: 6, ts: 6, type: 'tool/result', payload: { ok: true, name: 'shell', id: 'b', input: { command: 'pytest' }, startedAt: 5, durationMs: 10 } },
      { id: '7', seq: 7, ts: 7, type: 'turn/end', payload: { steps: 2 } },
    ]
    await writeFile(file, events.map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8')
    const trace = await deriveTraceMetrics(file, 1, 7)
    expect(trace.metrics.toolCalls).toBe(2)
    expect(trace.metrics.toolErrors).toBe(1)
    expect(trace.metrics.invalidToolCalls).toBe(1)
    expect(trace.metrics.retries).toBe(1)
    expect(trace.metrics.recoveredAfterError).toBe(true)
    expect(trace.durationMs).toBe(6)
  })
})
