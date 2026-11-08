import type { ComputerAction } from '@tnega/computer'
import type { DaemonComputerGuard } from '@tnega/daemon'

/** Keys pressed at this machine's terminal; returns the unsubscribe. */
export type KeySource = (listener: (key: string) => void) => () => void

export const PAUSE_KEY = 'p'
const CTRL_C = '\u0003'

export interface ComputerSwitchOptions {
  /** Keys from the terminal the daemon runs in; absent when it has none. */
  keys?: KeySource | undefined
  /** One line for the person at this machine. */
  write: (line: string) => void
  /** Ctrl+C: raw keys do not raise SIGINT, so the switch passes it on. */
  onQuit: () => void
}

/**
 * Text the agent chose, safe to print: control characters (CR, ESC, ...)
 * become `?` so they cannot rewrite the terminal or fake a status line, and
 * long text is cut.
 */
export function plain(text: string, max = 80): string {
  const clean = Array.from(text, char => {
    const code = char.codePointAt(0) ?? 0
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? '?' : char
  })
  return clean.length > max ? `${clean.slice(0, max).join('')}...` : clean.join('')
}

/** What an action does, in a few words, without the text it types. */
export function describeAction(action: ComputerAction): string {
  switch (action.op) {
    case 'launch': return `start ${plain(action.app)}`
    case 'clipboard-read': return 'read the clipboard'
    case 'clipboard-write': return 'write the clipboard'
    case 'type': return `type ${action.text.length} characters in window ${action.windowId}`
    case 'key': return `press ${plain(action.keys.join('+'))} in window ${action.windowId}`
    case 'menu': return `menu ${plain(action.path.join(' > '))} in window ${action.windowId}`
    case 'steps': return `${action.steps.length} steps in window ${action.windowId}`
    default: return `${action.op} in window ${action.windowId}`
  }
}

/**
 * Keeps the person at a daemon's machine in charge of computer use: it says
 * when computer use is on, shows every action as it runs, and `p` pauses it
 * (every call refused, screenshots too) until pressed again.
 */
export function computerSwitch(options: ComputerSwitchOptions): DaemonComputerGuard & { dispose(): void } {
  let paused = false
  options.write('tnega daemon: computer use is ON: an agent may see and use the apps on this machine.')
  const off = options.keys?.(key => {
    if (key === CTRL_C) { options.onQuit(); return }
    if (key.toLowerCase() !== PAUSE_KEY) return
    paused = !paused
    options.write(paused
      ? `tnega daemon: computer use PAUSED. Press ${PAUSE_KEY} to resume.`
      : `tnega daemon: computer use resumed. Press ${PAUSE_KEY} to pause.`)
  })
  options.write(off
    ? `tnega daemon: press ${PAUSE_KEY} to pause computer use, Ctrl+C to stop the daemon.`
    : 'tnega daemon: no terminal to read keys from; stop the daemon to stop computer use.')
  return {
    paused: () => paused ? 'the person at this computer paused computer use; ask them to resume it' : undefined,
    onAction: action => options.write(`tnega daemon: computer: ${describeAction(action)}`),
    dispose: () => off?.(),
  }
}

/** Single keys from this process's terminal, or `undefined` when stdin is not one. */
export function terminalKeys(input: NodeJS.ReadStream = process.stdin): KeySource | undefined {
  if (!input.isTTY) return undefined
  return listener => {
    const onData = (chunk: Buffer | string): void => {
      for (const key of String(chunk)) listener(key)
    }
    input.setRawMode(true)
    input.setEncoding('utf8')
    input.on('data', onData)
    input.resume()
    return () => {
      input.off('data', onData)
      input.setRawMode(false)
      input.pause()
    }
  }
}
