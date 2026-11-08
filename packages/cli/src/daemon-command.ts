import { resolve } from 'node:path'
import { assertSecureServerUrl, connectWebSocket, startDaemon, type Daemon } from '@tnega/daemon'
import type { PlaywrightBrowserHost } from '@tnega/browser-playwright'
import { CliError } from './commands.js'
import { computerSwitch, terminalKeys } from './daemon-computer.js'

export interface DaemonArgs {
  server: string
  token: string
  workspaces: string[]
  deviceId?: string
  /** Serve a browser on this machine for the runtime to drive. */
  browser?: boolean
  /** Let the runtime see and use the apps on this machine. */
  computer?: boolean
}

/** Environment variable for the token, so it stays out of the process list. */
export const DAEMON_TOKEN_ENV = 'TNEGA_DAEMON_TOKEN'

export function parseDaemonArgs(args: readonly string[], env: NodeJS.ProcessEnv = process.env): DaemonArgs {
  let server: string | undefined
  let token: string | undefined = env[DAEMON_TOKEN_ENV]
  let deviceId: string | undefined
  let browser = false
  let computer = false
  const workspaces: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined]
    const value = (): string => {
      const next = inline ?? args[++index]
      if (next === undefined || next === '') throw new CliError(`${flag} needs a value`)
      return next
    }
    switch (flag) {
      case '--server': server = value(); break
      case '--token': token = value(); break
      case '--workspace': workspaces.push(resolve(value())); break
      case '--device-id': deviceId = value(); break
      case '--browser':
        if (inline !== undefined) throw new CliError('--browser takes no value')
        browser = true
        break
      case '--computer':
        if (inline !== undefined) throw new CliError('--computer takes no value')
        computer = true
        break
      default: throw new CliError(`unknown option for tnega daemon: ${arg}`)
    }
  }
  if (!server) throw new CliError('tnega daemon needs --server <url>')
  if (!token) throw new CliError(`tnega daemon needs --token <token> or ${DAEMON_TOKEN_ENV}`)
  return {
    server,
    token,
    workspaces: workspaces.length ? workspaces : [resolve(process.cwd())],
    ...(deviceId ? { deviceId } : {}),
    ...(browser ? { browser: true } : {}),
    ...(computer ? { computer: true } : {}),
  }
}

async function openBrowser(): Promise<PlaywrightBrowserHost> {
  const { PlaywrightBrowserHost, launchPageSource } = await import('@tnega/browser-playwright')
  return new PlaywrightBrowserHost(launchPageSource())
}

/** This machine's `ctx.computer` (cua-driver), in a scope of its own that closes the driver. */
async function openComputer() {
  const [{ Context }, { computerCua }] = await Promise.all([import('@tnega/core'), import('@tnega/computer-cua')])
  const ctx = new Context()
  const fiber = ctx.plugin(computerCua, {})
  await fiber
  return { computer: ctx.get('computer'), close: () => fiber.dispose() }
}

/**
 * `tnega daemon`: serve this machine's files and commands to a tnega server.
 * Runs until interrupted; a dropped connection is dialled again.
 */
export async function runDaemonCommand(args: readonly string[]): Promise<number> {
  const parsed = parseDaemonArgs(args)
  // Commands the daemon runs inherit its environment; the token is not theirs.
  delete process.env[DAEMON_TOKEN_ENV]
  // A refused address is a mistake to report, not a connection to retry.
  assertSecureServerUrl(parsed.server)
  let interrupted = false
  let settle: (code: number) => void = () => {}
  // Ends with 0 on SIGINT / SIGTERM, with 1 when the daemon stops by itself (a refused reconnect).
  const finished = new Promise<number>(done => { settle = done })
  // A browser of its own (a fresh profile, not the person's), started on first use.
  const browser = parsed.browser ? await openBrowser() : undefined
  // Computer use only when the person here asked for it, with a pause key while it runs.
  const computer = parsed.computer ? await openComputer() : undefined
  const guard = computer
    ? computerSwitch({ keys: terminalKeys(), write: line => process.stderr.write(`${line}\n`), onQuit: () => stop() })
    : undefined
  const closeExtras = async (): Promise<void> => {
    guard?.dispose()
    await browser?.close().catch(() => undefined)
    await computer?.close().catch(() => undefined)
  }
  const daemon: Daemon = startDaemon({
    ...(browser ? { browser } : {}),
    ...(computer ? { computer: { computer: computer.computer, ...(guard ? { guard } : {}) } } : {}),
    connect: () => connectWebSocket(parsed.server, { token: parsed.token }),
    workspaces: parsed.workspaces.map(path => ({ path })),
    ...(parsed.deviceId ? { deviceId: parsed.deviceId } : {}),
    onState: (state, detail) => {
      process.stderr.write(`tnega daemon: ${state}${detail ? ` (${detail})` : ''}\n`)
      if (state === 'stopped' && !interrupted) settle(1)
    },
  })
  const stop = (): void => {
    interrupted = true
    void daemon.close().then(closeExtras).then(() => settle(0))
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    for (const workspace of daemon.workspaces) process.stderr.write(`tnega daemon: serving ${workspace.path} as ${workspace.id}\n`)
    // Interrupted before the first handshake is a normal stop, not a failure.
    const first = await Promise.race([daemon.ready.then(() => undefined), finished])
    if (first !== undefined) return first
    return await finished
  } catch (error) {
    if (interrupted) return await finished
    await daemon.close()
    throw error
  } finally {
    if (!interrupted) await closeExtras()
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}
