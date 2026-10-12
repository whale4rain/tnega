import { CliError } from './commands.js'
import { main as runCommand } from './index.js'

/**
 * The `tnega` executable: every library command plus `tui`, which lives
 * outside `index.ts` so embedding hosts do not bundle the terminal UI.
 */
export async function main(argv: readonly string[]): Promise<number> {
  if (argv[0] !== 'tui') return runCommand(argv)
  try {
    const { runTuiCommand } = await import('./tui-command.js')
    return await runTuiCommand(argv.slice(1))
  } catch (error) {
    const message = error instanceof CliError || error instanceof Error ? error.message : String(error)
    process.stdout.write(`error: ${message}\n`)
    return 2
  }
}
