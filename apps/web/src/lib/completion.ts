/**
 * Composer completion: what the user is typing at the caret (a slash command,
 * one of its arguments, or an `@` file mention) and how to rank candidates.
 * Pure functions, so the behaviour is testable without a DOM.
 */

export type Trigger =
  /** `/pl|` at the start of the message: complete the command name. */
  | { kind: 'command', query: string, start: number, end: number }
  /** `/model gp|`: complete the first argument of `command`. */
  | { kind: 'argument', command: string, query: string, start: number, end: number }
  /** `see @rep|`: complete a workspace file path. */
  | { kind: 'mention', query: string, start: number, end: number }

export function detectTrigger(text: string, caret: number): Trigger | undefined {
  const before = text.slice(0, caret)
  const command = /^\/(\S*)$/.exec(before)
  if (command) return { kind: 'command', query: command[1] ?? '', start: 0, end: caret }
  const argument = /^(\/\S+)\s+(\S*)$/.exec(before)
  if (argument) {
    const query = argument[2] ?? ''
    return { kind: 'argument', command: argument[1] ?? '', query, start: caret - query.length, end: caret }
  }
  const mention = /(?:^|\s)@([^\s@]*)$/.exec(before)
  if (mention) {
    const query = mention[1] ?? ''
    return { kind: 'mention', query, start: caret - query.length - 1, end: caret }
  }
  return undefined
}

/** Replace the trigger's span with `insert`, returning the new text and caret. */
export function applyCompletion(text: string, trigger: Trigger, insert: string): { text: string, caret: number } {
  const next = `${text.slice(0, trigger.start)}${insert}${text.slice(trigger.end)}`
  return { text: next, caret: trigger.start + insert.length }
}

export interface CommandSpec {
  /** With the leading slash, e.g. `/plan`. */
  name: string
  description: string
  /** Shown after the name, e.g. `<request>`. */
  usage?: string
  /** `client` commands run in the UI; `server` commands go to the coding agent. */
  source: 'client' | 'server'
  /** Whether the command takes an argument worth completing. */
  hasArguments?: boolean
}

/** Commands every session understands; the UI carries them out itself. */
export const CLIENT_COMMANDS: readonly CommandSpec[] = [
  { name: '/plan', usage: '[request]', description: 'Switch to Plan mode: draft a step-by-step plan first, then send the request.', source: 'client' },
  { name: '/goal', usage: '[objective]', description: 'Switch to Goal mode: keep working across rounds until the objective is met.', source: 'client' },
  { name: '/auto', description: 'Switch back to Auto mode: work on requests directly.', source: 'client' },
  { name: '/model', usage: '<model>', description: 'Use another model for this session.', source: 'client', hasArguments: true },
  { name: '/compact', description: 'Summarise the conversation so far to free up context.', source: 'client' },
  { name: '/codemode', usage: '[on|off]', description: 'Enable or disable CodeMode (PTC) for subsequent runs.', source: 'client', hasArguments: true },
  { name: '/rename', usage: '<title>', description: 'Rename this session.', source: 'client' },
]

/** Server commands the client already covers better (mode switching lives in the UI). */
const SHADOWED = new Set(['/plan', '/goal', '/mode'])

export function mergeCommands(server: ReadonlyArray<{ name: string, description: string }>): CommandSpec[] {
  const extra = server
    .map(command => ({ ...command, name: command.name.startsWith('/') ? command.name : `/${command.name}` }))
    .filter(command => !SHADOWED.has(command.name))
    .map((command): CommandSpec => ({ name: command.name, description: command.description, source: 'server', hasArguments: true }))
  return [...CLIENT_COMMANDS, ...extra]
}

/** Commands for a query: name prefix first, then name substring, then description. */
export function rankCommands(commands: readonly CommandSpec[], query: string): CommandSpec[] {
  const needle = query.toLowerCase()
  if (!needle) return [...commands]
  const scored = commands.flatMap(command => {
    const name = command.name.slice(1).toLowerCase()
    const score = name.startsWith(needle) ? 0 : name.includes(needle) ? 1 : command.description.toLowerCase().includes(needle) ? 2 : -1
    return score < 0 ? [] : [{ command, score }]
  })
  return scored.sort((a, b) => a.score - b.score).map(entry => entry.command)
}

/** `/name rest of text` → `{ name, rest }`; anything else → undefined. */
export function parseCommand(text: string): { name: string, rest: string } | undefined {
  const match = /^(\/\S+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  return match ? { name: match[1] ?? '', rest: (match[2] ?? '').trim() } : undefined
}
