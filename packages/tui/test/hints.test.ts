import { describe, expect, it } from 'vitest'
import { fitHints, keyHints, type HintContext } from '../src/hints.js'
import { kittyReply } from '../src/terminal.js'
import { stringWidth } from '../src/width.js'

const idle: HintContext = { completing: false, live: false, empty: true, shiftEnter: true, verbose: false, foldedSteps: 0 }

describe('key hints', () => {
  it('names the keys for an empty box, with the newline key the terminal supports', () => {
    expect(keyHints(idle)).toEqual(['enter send', 'shift+enter new line', '/ commands', '@ files', '? all keys'])
    expect(keyHints({ ...idle, shiftEnter: false })[1]).toBe('ctrl+j new line')
    expect(keyHints({ ...idle, foldedSteps: 3 })[2]).toBe('ctrl+o show the last 3 steps')
  })

  it('points at the folded steps of the last turn while typing', () => {
    expect(keyHints({ ...idle, empty: false, foldedSteps: 6 })).toContain('ctrl+o show the last 6 steps')
    expect(keyHints({ ...idle, empty: false, foldedSteps: 1 })).toContain('ctrl+o show the last step')
    expect(keyHints({ ...idle, empty: false, verbose: true })).toContain('ctrl+o fold steps')
  })

  it('switches to stop, steer and queue while a run goes, and to list keys while completing', () => {
    expect(keyHints({ ...idle, live: true }).slice(0, 3)).toEqual(['esc stop', 'enter steer now', 'tab queue for later'])
    expect(keyHints({ ...idle, completing: true, live: true })[0]).toBe('↑↓ choose')
  })

  it('drops hints from the right to fit, keeping ? all keys', () => {
    const row = fitHints(keyHints(idle), 40)
    expect(stringWidth(row)).toBeLessThanOrEqual(40)
    expect(row.startsWith('enter send')).toBe(true)
    expect(row.endsWith('? all keys')).toBe(true)
  })
})

describe('kitty keyboard reply', () => {
  it('finds the flags reply among other input', () => {
    expect(kittyReply('ab\u001B[?1uc')).toBe('\u001B[?1u')
    expect(kittyReply('\u001B[?u')).toBe('\u001B[?u')
    expect(kittyReply('\u001B[?1;2c')).toBeUndefined()
  })
})
