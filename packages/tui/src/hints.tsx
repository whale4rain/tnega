/**
 * The key hint row under the composer and the `?` key sheet. The row names
 * only the few keys that matter in the current state, so nobody has to
 * remember them; the sheet lists the rest.
 */
import { Box, Text } from 'ink'
import { glyph } from './theme.js'
import { padEnd, stringWidth } from './width.js'

export interface HintContext {
  /** The completion list is open. */
  completing: boolean
  /** A run is going (here or elsewhere). */
  live: boolean
  /** Nothing typed yet. */
  empty: boolean
  /** The terminal reports Shift+Enter apart from Enter. */
  shiftEnter: boolean
  /** Ctrl+O shows every step. */
  verbose: boolean
  /** Steps folded away in the last finished turn. */
  foldedSteps: number
}

/** Hints in order of importance; the last one is kept when the row runs out of room. */
export function keyHints(context: HintContext): string[] {
  if (context.completing) return ['↑↓ choose', 'tab complete', 'enter run', 'esc close']
  if (context.live) return ['esc stop', 'enter steer now', 'tab queue for later', context.verbose ? 'ctrl+o fold steps' : 'ctrl+o show steps']
  const newline = context.shiftEnter ? 'shift+enter new line' : 'ctrl+j new line'
  const steps = context.verbose
    ? 'ctrl+o fold steps'
    : context.foldedSteps > 0
      ? `ctrl+o show the last ${context.foldedSteps === 1 ? 'step' : `${context.foldedSteps} steps`}`
      : undefined
  if (context.empty) return ['enter send', newline, ...(steps ? [steps, '/ commands'] : ['/ commands', '@ files']), '? all keys']
  return ['enter send', newline, steps ?? '↑ earlier prompts']
}

const SEPARATOR = ` ${glyph.bullet} `

/** Join hints into one row of at most `width` cells, dropping from the right but keeping `? all keys`. */
export function fitHints(hints: readonly string[], width: number): string {
  const pinned = hints.at(-1) === '? all keys' ? hints.at(-1) : undefined
  const items = pinned ? hints.slice(0, -1) : [...hints]
  const join = (list: readonly string[]) => [...list, ...(pinned ? [pinned] : [])].join(SEPARATOR)
  while (items.length > 1 && stringWidth(join(items)) > width) items.pop()
  return join(items)
}

export function KeyHints({ context, width }: { context: HintContext; width: number }) {
  return <Text dimColor>{'  '}{fitHints(keyHints(context), width - 2)}</Text>
}

type Row = readonly [string, string]

/** Every key, in two columns: typing on the left, the screen on the right. */
export function keySheet(shiftEnter: boolean): { left: Row[]; right: Row[] } {
  return {
    left: [
      ['enter', 'send; steer while it runs'],
      [shiftEnter ? 'shift+enter' : 'ctrl+j', `new line${shiftEnter ? ' (also ctrl+j)' : ' (also alt+enter)'}`],
      ['tab', 'queue while it runs (also alt+enter)'],
      ['shift+tab', 'auto · plan · goal'],
      ['↑ ↓', 'earlier prompts; a queued message'],
      ['ctrl+a ctrl+e', 'line start · end'],
      ['ctrl+u ctrl+k', 'delete to start · end'],
      ['ctrl+w', 'delete a word'],
      ['/  @', 'commands · files'],
    ],
    right: [
      ['ctrl+o', 'fold or show steps'],
      ['esc', 'stop · close'],
      ['ctrl+x', 'drop a queued message'],
      ['ctrl+c', 'clear · twice quits'],
      ['ctrl+d', 'quit on an empty box'],
      ['y  n', 'allow · deny a tool'],
      ['/help', 'every command'],
    ],
  }
}

export function KeySheet({ shiftEnter, width }: { shiftEnter: boolean; width: number }) {
  const { left, right } = keySheet(shiftEnter)
  const keyWidth = (rows: readonly Row[]) => Math.max(...rows.map(([key]) => stringWidth(key))) + 2
  const leftKey = keyWidth(left)
  const rightKey = keyWidth(right)
  const leftWidth = leftKey + Math.max(...left.map(([, text]) => stringWidth(text))) + 3
  const twoColumns = 2 + leftWidth + rightKey + Math.max(...right.map(([, text]) => stringWidth(text))) <= width
  const lines = twoColumns
    ? left.map((row, index) => [row, right[index]] as const)
    : [...left, ...right].map(row => [row, undefined] as const)
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{'  '}Keys</Text>
      {lines.map(([row, other], index) => (
        <Text key={index}>
          {'  '}{padEnd(row[0], leftKey)}<Text dimColor>{other ? padEnd(row[1], leftWidth - leftKey) : row[1]}</Text>
          {other ? <>{padEnd(other[0], rightKey)}<Text dimColor>{other[1]}</Text></> : null}
        </Text>
      ))}
      <Text dimColor>{'  '}? or esc to close</Text>
    </Box>
  )
}
