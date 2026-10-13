import { createClient } from '@tnega/client'
import { render } from 'ink'
import { App } from './app.js'
import { TuiController, type RunSettings } from './controller.js'
import { supportsKittyKeyboard } from './terminal.js'

export interface TuiOptions {
  /** Origin of the tnega server the TUI talks to. */
  baseUrl: string
  /** Folder the sessions belong to; the current directory by default. */
  workspace: string
  /** A session id to open, or `last` for the most recent one. */
  session?: string
  /** Settings for new sessions. */
  draft?: Partial<RunSettings>
  /** Open a URL in the system browser; returns false when nothing could. */
  openUrl?: (url: string) => boolean
}

/** Why the TUI cannot run in this process, or undefined when it can. */
export function terminalProblem(): string | undefined {
  if (process.stdin.isTTY && process.stdout.isTTY) return undefined
  return 'tnega tui needs an interactive terminal. Use `tnega run "<prompt>"` in scripts.'
}

/** Run the TUI until the user quits; resolves with the process exit code. */
export async function runTui(options: TuiOptions): Promise<number> {
  const problem = terminalProblem()
  if (problem) {
    process.stderr.write(`${problem}\n`)
    return 2
  }
  const client = createClient({ baseUrl: options.baseUrl })
  const controller = new TuiController(client, options.workspace, options.draft ? { draft: options.draft } : {})
  // Shift+Enter is only distinguishable from Enter under the kitty protocol;
  // knowing up front lets the key hints name the newline key that works.
  const kitty = await supportsKittyKeyboard()
  const instance = render(
    <App controller={controller} webUrl={options.baseUrl} openUrl={options.openUrl ?? (() => false)} shiftEnter={kitty} />,
    {
      exitOnCtrlC: false,
      kittyKeyboard: { mode: kitty ? 'enabled' : 'disabled', flags: ['disambiguateEscapeCodes'] },
    },
  )
  void controller.start(options.session)
  try {
    await instance.waitUntilExit()
  } finally {
    controller.dispose()
  }
  return 0
}
