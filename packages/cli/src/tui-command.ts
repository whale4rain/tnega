import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { CliError } from './commands.js'
import { defaultHotProfile } from './plugin-hmr.js'
import { resolveProfileFile } from './profile-file.js'
import { startWebServer } from './server.js'

/**
 * `tnega tui`: start the server in this process on a free loopback port (or
 * attach to a running one with `--url`) and hand the terminal to the TUI.
 * Kept out of the library entry so hosts that embed the server (the desktop
 * app) never bundle React and Ink.
 */
export async function runTuiCommand(args: readonly string[]): Promise<number> {
  const parsed = parseTuiArgs(args)
  // Loaded on demand: other commands never pay for React and Ink.
  const { runTui, terminalProblem } = await import('@tnega/tui')
  // Checked before the server starts, so a pipe or a script gets the hint at once.
  const problem = terminalProblem()
  if (problem) {
    process.stderr.write(`${problem}\n`)
    return 2
  }
  const server = parsed.url
    ? undefined
    : await startWebServer({
        host: '127.0.0.1',
        // Any free port: the TUI is the server's only client unless /web opens the page.
        port: parsed.port ?? 0,
        ...(parsed.configFile ? { configFile: parsed.configFile } : {}),
        ...(parsed.profile !== false ? { profile: parsed.profile ?? defaultHotProfile() } : {}),
        ...(parsed.pluginDev ? { pluginDev: true } : {}),
      })
  try {
    return await runTui({
      baseUrl: parsed.url ?? server!.url,
      workspace: resolve(parsed.cwd ?? process.cwd()),
      ...(parsed.session ? { session: parsed.session } : {}),
      openUrl,
    })
  } finally {
    await server?.close()
  }
}

interface ParsedTuiArgs {
  /** An already running tnega server to attach to instead of starting one. */
  url?: string
  port?: number
  cwd?: string
  configFile?: string
  /** A session id, or `last` from `--continue`. */
  session?: string
  profile?: string | false
  /** `--plugin-dev`: the agent may write plugins and patch them into itself. */
  pluginDev?: boolean
}

const VALUE_OPTIONS = ['--url', '--port', '--cwd', '--config', '--config-file', '--session', '--profile']

export function parseTuiArgs(args: readonly string[]): ParsedTuiArgs {
  const parsed: ParsedTuiArgs = {}
  let cursor = 0
  while (cursor < args.length) {
    const arg = args[cursor]!
    if (arg === '--no-plugins') {
      parsed.profile = false
      cursor += 1
      continue
    }
    if (arg === '--plugin-dev') {
      parsed.pluginDev = true
      cursor += 1
      continue
    }
    if (arg === '--continue' || arg === '-c') {
      parsed.session = 'last'
      cursor += 1
      continue
    }
    if (VALUE_OPTIONS.includes(arg)) {
      const value = args[cursor + 1]
      if (!value) throw new CliError(`${arg} requires a value`)
      if (arg === '--url') parsed.url = value.replace(/\/+$/, '')
      if (arg === '--port') {
        const port = Number(value)
        if (!Number.isInteger(port) || port < 0) throw new CliError('--port requires a port number')
        parsed.port = port
      }
      if (arg === '--cwd') parsed.cwd = value
      if (arg === '--config' || arg === '--config-file') parsed.configFile = value
      if (arg === '--session') parsed.session = value
      if (arg === '--profile') parsed.profile = resolveProfileFile(value)
      cursor += 2
      continue
    }
    throw new CliError(`unknown option: ${arg}`)
  }
  return parsed
}

/** Open `url` with the system's default browser; false when no opener could start. */
function openUrl(url: string): boolean {
  const [command, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]]
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => undefined)
    child.unref()
    return true
  } catch {
    return false
  }
}
