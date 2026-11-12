import { resolve } from 'node:path'
import { Context } from '@tnega/core'
import { GvisorMachines, groupId, probeGvisorHost, startBoxd, type GvisorMachineConfig } from '@tnega/machine-gvisor'
import { CliError } from './commands.js'

/**
 * `tnega boxd`: the root helper of a gVisor host (issue #91). It is the only
 * process that runs runsc, `ip`, `nft` and cgroups; `tnega server start`
 * runs as an ordinary user and reaches it through `TNEGA_BOXD_SOCKET`.
 */

export const DEFAULT_BOXD_SOCKET = '/run/tnega/boxd.sock'

export interface BoxdArgs {
  socket: string
  group?: string
  workspaceRoots: string[]
  config: GvisorMachineConfig
}

const PLATFORMS = ['systrap', 'ptrace', 'kvm'] as const

export function parseBoxdArgs(args: readonly string[]): BoxdArgs {
  let socket = DEFAULT_BOXD_SOCKET
  let group: string | undefined
  const workspaceRoots: string[] = []
  const config: GvisorMachineConfig = {}
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!
    const value = (): string => {
      const next = args[index + 1]
      if (next === undefined || next.startsWith('--')) throw new CliError(`${flag} needs a value`)
      index += 1
      return next
    }
    switch (flag) {
      case '--socket': socket = value(); break
      case '--group': group = value(); break
      case '--workspace-root': workspaceRoots.push(resolve(value())); break
      case '--state-dir': config.stateDir = resolve(value()); break
      case '--templates-dir': config.templatesDir = resolve(value()); break
      case '--runsc-root': config.runscRoot = resolve(value()); break
      case '--runsc': config.runsc = value(); break
      case '--platform': {
        const platform = value()
        const known = PLATFORMS.find(entry => entry === platform)
        if (!known) throw new CliError(`--platform must be ${PLATFORMS.join(', ')}`)
        config.platform = known
        break
      }
      default: throw new CliError(`unknown option ${flag} for tnega boxd`)
    }
  }
  if (!workspaceRoots.length) {
    throw new CliError('tnega boxd needs --workspace-root <dir>: the folder (or folders) whose subfolders boxes may mount, such as the server\'s members folder')
  }
  return { socket: resolve(socket), ...(group === undefined ? {} : { group }), workspaceRoots, config }
}

export async function runBoxdCommand(args: readonly string[]): Promise<number> {
  const parsed = parseBoxdArgs(args)
  const probe = await probeGvisorHost(parsed.config.runsc === undefined ? {} : { runsc: parsed.config.runsc })
  if (!probe.ready) {
    process.stderr.write(`tnega boxd: this host cannot run gVisor boxes:\n${probe.problems.map(problem => `  - ${problem}`).join('\n')}\n`)
    return 1
  }
  const gid = parsed.group === undefined ? undefined : await groupId(parsed.group)
  const scope = new Context()
  const machines = new GvisorMachines(scope, parsed.config)
  const boxd = await startBoxd({ socket: parsed.socket, machines, workspaceRoots: parsed.workspaceRoots, ...(gid === undefined ? {} : { gid }) })
  process.stderr.write(`tnega boxd: listening on ${boxd.socket}${parsed.group ? ` for group ${parsed.group}` : ' (root only)'}\n`)
  return await new Promise<number>(done => {
    const stop = (): void => {
      void boxd.close().catch(() => undefined).then(() => scope.fiber.dispose()).then(() => done(0), () => done(0))
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}
