import { describe, expect, it } from 'vitest'
import { formatElapsed, mergeTasks, shortUrl, taskMeta } from './background-tasks'

describe('background tasks', () => {
  it('orders live work newest first, then finished work by when it finished', () => {
    const tasks = mergeTasks([
      { id: 'a', kind: 'tool', label: 'A', status: 'completed', startedAt: 1, finishedAt: 50, reported: true },
      { id: 'b', kind: 'tool', label: 'B', status: 'running', startedAt: 10, reported: false },
      { id: 'c', kind: 'subagent', label: 'C', status: 'failed', startedAt: 5, finishedAt: 90, detail: 'subagent x: error', reported: true },
    ], [{ id: 'p1', command: 'vite', cwd: '/w', startedAt: 20, status: 'running', urls: [] }])
    expect(tasks.map(task => task.label)).toEqual(['vite', 'B', 'C', 'A'])
    expect(tasks.map(task => task.kind)).toEqual(['process', 'tool', 'subagent', 'tool'])
  })

  it('describes state and time in one line', () => {
    const [failed] = mergeTasks([{ id: 'j', kind: 'tool', label: 'tests', status: 'failed', startedAt: 0, finishedAt: 72_000, detail: 'exit code 1', reported: true }], [])
    expect(taskMeta(failed!, 0)).toBe('Failed · took 1m 12s · exit code 1')
    const [running] = mergeTasks([{ id: 'j', kind: 'tool', label: 'dev', status: 'running', startedAt: 0, reported: false, processId: 'p1' }], [])
    expect(taskMeta(running!, 3_725_000)).toBe('Running · 1h 2m')
    expect(formatElapsed(8_400)).toBe('8s')
    expect(formatElapsed(300)).toBe('<1s')
    expect(shortUrl('http://localhost:5173/')).toBe('localhost:5173')
    expect(shortUrl('http://127.0.0.1:3000/app')).toBe('127.0.0.1:3000/app')
  })
})
