import { describe, expect, it } from 'vitest'
import { applyCompletion, detectTrigger, mergeCommands, parseCommand, rankCommands } from './completion'

describe('detectTrigger', () => {
  it('recognises commands, their first argument and file mentions at the caret', () => {
    expect(detectTrigger('/pl', 3)).toEqual({ kind: 'command', query: 'pl', start: 0, end: 3 })
    expect(detectTrigger('/model gp', 9)).toEqual({ kind: 'argument', command: '/model', query: 'gp', start: 7, end: 9 })
    expect(detectTrigger('/model ', 7)).toEqual({ kind: 'argument', command: '/model', query: '', start: 7, end: 7 })
    expect(detectTrigger('summarise @out/q2', 17)).toEqual({ kind: 'mention', query: 'out/q2', start: 10, end: 17 })
    expect(detectTrigger('@', 1)).toEqual({ kind: 'mention', query: '', start: 0, end: 1 })
  })

  it('ignores text that is not a trigger', () => {
    expect(detectTrigger('hello', 5)).toBeUndefined()
    expect(detectTrigger('mail me@example.com', 19)).toBeUndefined()
    expect(detectTrigger('/model gpt extra', 16)).toBeUndefined()
    expect(detectTrigger('see @file.md and', 16)).toBeUndefined()
  })
})

describe('applyCompletion', () => {
  it('replaces only the trigger span and places the caret after it', () => {
    const trigger = detectTrigger('read @rep then', 9)
    expect(trigger && applyCompletion('read @rep then', trigger, '@outputs/report.docx ')).toEqual({ text: 'read @outputs/report.docx  then', caret: 26 })
  })
})

describe('commands', () => {
  const merged = mergeCommands([{ name: '/plan', description: 'server plan' }, { name: 'skills', description: 'List workspace skills' }, { name: '/mode', description: 'x' }])

  it('keeps client commands, adds server ones and drops the ones the client handles', () => {
    expect(merged.map(command => command.name)).toEqual(['/plan', '/goal', '/auto', '/model', '/compact', '/codemode', '/rename', '/skills'])
    expect(merged.find(command => command.name === '/plan')?.source).toBe('client')
  })

  it('ranks by name prefix, then name, then description', () => {
    // `/model` matches by name; `/plan`, `/goal` and `/auto` only through "mode" in their descriptions.
    expect(rankCommands(merged, 'mo').map(command => command.name)).toEqual(['/model', '/codemode', '/plan', '/goal', '/auto'])
    expect(rankCommands(merged, 'ill').map(command => command.name)).toEqual(['/skills'])
    expect(rankCommands(merged, 'context').map(command => command.name)).toEqual(['/compact'])
  })

  it('parses a command and its argument text', () => {
    expect(parseCommand('/plan  add a chart ')).toEqual({ name: '/plan', rest: 'add a chart' })
    expect(parseCommand('/auto')).toEqual({ name: '/auto', rest: '' })
    expect(parseCommand('no command')).toBeUndefined()
  })
})
