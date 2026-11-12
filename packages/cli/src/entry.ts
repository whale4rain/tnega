import { CliError } from './commands.js'
import { commandHelp, hasCommandHelp, isHelpFlag, isVersionFlag, mainHelp, tnegaVersion } from './help.js'
import { main as runCommand } from './index.js'

export interface EntryOptions {
  /** Whether stdin and stdout are a terminal; decides what a bare `tnega` does. */
  interactive?: boolean
}

/**
 * The `tnega` executable: every library command plus `tui`, which lives
 * outside `index.ts` so embedding hosts do not bundle the terminal UI, and
 * the help and version output.
 */
export async function main(argv: readonly string[], options: EntryOptions = {}): Promise<number> {
  const [command, ...rest] = argv
  if (command === undefined) {
    const interactive = options.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true)
    // In a terminal a bare `tnega` opens the TUI; in a pipe or script it explains itself.
    if (!interactive) return print(mainHelp(), 2)
    return runTui([])
  }
  if (isHelpFlag(command)) return print(mainHelp(), 0)
  if (isVersionFlag(command)) return print(`${tnegaVersion()}\n`, 0)
  if (command === 'help') return print(hasCommandHelp(rest[0]) ? commandHelp(rest[0]!) : mainHelp(), 0)
  if (hasCommandHelp(command) && rest.some(isHelpFlag)) return print(commandHelp(command), 0)
  if (command === 'tui') return runTui(rest)
  if (command === 'daemon') return runDaemon(rest)
  if (command === 'server') return runServer(rest)
  if (command === 'boxd') return runBoxd(rest)
  // `tnega --continue`, `tnega --cwd x`: options without a command are the TUI's.
  if (command.startsWith('-')) return runTui(argv)
  return runCommand(argv)
}

async function runTui(args: readonly string[]): Promise<number> {
  try {
    const { runTuiCommand } = await import('./tui-command.js')
    return await runTuiCommand(args)
  } catch (error) {
    const message = error instanceof CliError || error instanceof Error ? error.message : String(error)
    process.stdout.write(`error: ${message}\n`)
    return 2
  }
}

async function runDaemon(args: readonly string[]): Promise<number> {
  try {
    const { runDaemonCommand } = await import('./daemon-command.js')
    return await runDaemonCommand(args)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stdout.write(`error: ${message}\n`)
    return 2
  }
}

async function runBoxd(args: readonly string[]): Promise<number> {
  try {
    const { runBoxdCommand } = await import('./boxd-command.js')
    return await runBoxdCommand(args)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stdout.write(`error: ${message}\n`)
    return 2
  }
}

async function runServer(args: readonly string[]): Promise<number> {
  try {
    const { runServerCommand, terminalIo } = await import('./server-command.js')
    return await runServerCommand(args, terminalIo())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stdout.write(`error: ${message}\n`)
    return 2
  }
}

function print(text: string, code: number): number {
  process.stdout.write(text)
  return code
}
