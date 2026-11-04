import { resolve } from 'node:path'
import { assertSecureServerUrl, connectWebSocket, startDaemon, type Daemon } from '@tnega/daemon'
import { CliError } from './commands.js'

export interface DaemonArgs {
  server: string
  token: string
  workspaces: string[]
  deviceId?: string
}

/** Environment variable for the token, so it stays out of the process list. */
export const DAEMON_TOKEN_ENV = 'TNEGA_DAEMON_TOKEN'

export function parseDaemonArgs(args: readonly string[], env: NodeJS.ProcessEnv = process.env): DaemonArgs {
  let server: string | undefined
  let token: string | undefined = env[DAEMON_TOKEN_ENV]
  let deviceId: string | undefined
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
  }
}

/**
 * `tnega daemon`: serve this machine's files and commands to a tnega server.
 * Runs until interrupted; a dropped connection is dialled again.
 */
export async function runDaemonCommand(args: readonly string[]): Promise<number> {
  const parsed = parseDaemonArgs(args)
  // A refused address is a mistake to report, not a connection to retry.
  assertSecureServerUrl(parsed.server)
  const daemon: Daemon = startDaemon({
    connect: () => connectWebSocket(parsed.server, { token: parsed.token }),
    workspaces: parsed.workspaces.map(path => ({ path })),
    ...(parsed.deviceId ? { deviceId: parsed.deviceId } : {}),
    onState: (state, detail) => process.stderr.write(`tnega daemon: ${state}${detail ? ` (${detail})` : ''}\n`),
  })
  for (const workspace of daemon.workspaces) process.stderr.write(`tnega daemon: serving ${workspace.path} as ${workspace.id}\n`)
  const stopped = new Promise<number>(done => {
    const stop = (): void => { void daemon.close().then(() => done(0)) }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  try {
    await daemon.ready
  } catch (error) {
    await daemon.close()
    throw error
  }
  return await stopped
}
