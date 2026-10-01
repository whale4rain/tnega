import { describe, expect, it } from 'vitest'
import type { Entry } from './timeline'
import { sessionWeather, turnWeather } from './weather'

type AgentEntry = Extract<Entry, { kind: 'agent' }>

function turn(blocks: AgentEntry['blocks'], status: AgentEntry['status'] = 'running'): AgentEntry {
  return { kind: 'agent', id: 'a', blocks, status }
}

const tool = (callId: string, status: 'running' | 'ok' | 'error') => ({ kind: 'tool' as const, id: callId, tool: { callId, name: 'shell', args: {}, status } })

describe('turnWeather', () => {
  it('reads a live run as cloudy, drizzle or rain by how much is running', () => {
    expect(turnWeather(turn([]), { live: true })).toBe('cloudy')
    expect(turnWeather(turn([tool('a', 'running')]), { live: true })).toBe('drizzle')
    expect(turnWeather(turn([tool('a', 'running'), tool('b', 'running')]), { live: true })).toBe('rain')
    expect(turnWeather(turn([tool('a', 'ok')]), { live: true })).toBe('cloudy')
  })

  it('puts the user and failures first', () => {
    expect(turnWeather(turn([tool('a', 'running')]), { live: true, waiting: true })).toBe('snow')
    expect(turnWeather(turn([], 'error'), { live: false })).toBe('storm')
  })

  it('shows helpers starting, retries, a full context and a fresh finish', () => {
    const spawning = turn([{ kind: 'subagent', id: 's', agent: { label: 'x', task: 't', mode: 'spawn', status: 'starting', replies: [] } }])
    expect(turnWeather(spawning, { live: true })).toBe('sprite')
    expect(turnWeather(turn([{ kind: 'notice', id: 'n', tone: 'warn', text: 'Request failed, retrying in 2s' }]), { live: true })).toBe('sleet')
    expect(turnWeather(turn([], 'done'), { live: false, contextRatio: 0.9 })).toBe('fog')
    expect(turnWeather(turn([], 'done'), { live: false, justFinished: true })).toBe('rainbow')
    expect(turnWeather(turn([], 'done'), { live: false })).toBe('clear')
  })
})

describe('sessionWeather', () => {
  it('only forecasts sessions that need attention or are running', () => {
    expect(sessionWeather({ waiting: true, running: true })).toBe('snow')
    expect(sessionWeather({ running: true })).toBe('drizzle')
    expect(sessionWeather({ failed: true })).toBe('storm')
    expect(sessionWeather({})).toBeUndefined()
  })
})
