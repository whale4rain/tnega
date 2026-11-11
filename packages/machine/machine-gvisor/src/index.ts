import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { access, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isIPv4 } from 'node:net'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import type { Context } from '@tnega/core'
import {
  boxEnvironment,
  MachineError,
  MachineService,
  validateBoxSpec,
  type BoxSpec,
  type MachineRef,
  type MachineState,
} from '@tnega/machine'
import { boxNet, MAX_BOXES, netnsPath, networkDown, networkUp, type BoxNet, type HostCommand } from './network.js'
import { ociConfig, runscGlobals, runscRestore, runscRun, type BoxPaths, type RunscGlobals } from './oci.js'

export { boxNet, netnsPath, networkDown, networkUp, nftRuleset, type BoxNet, type HostCommand } from './network.js'
export { DEFAULT_RESOURCES, ociConfig, runscGlobals, runscRestore, runscRun, type BoxPaths, type RunscGlobals } from './oci.js'

/**
 * `@tnega/machine-gvisor`: boxes as gVisor sandboxes, for hosts without KVM
 * (a cloud VM with no nested virtualization), issue #85. Not a VM: the box's
 * syscalls are served by gVisor's user-space kernel (the sentry), and its
 * network is a netstack inside the sentry behind a namespace and nftables
 * rules on the host.
 *
 * - **Isolation.** Serves `container` and `gvisor`; a `microvm` box is
 *   refused with `SANDBOX_UNAVAILABLE`. It never downgrades: the composition
 *   layer opts a host into gVisor, the Provider does not fall back to it.
 * - **Filesystem.** The template's root filesystem (deploy/gvisor) is a
 *   shared lower layer nobody writes; each box writes into its own overlay
 *   filestore; the workspace is a host folder mounted into the box.
 * - **Network.** One namespace and veth pair per box; `egress` and `none`
 *   allow only the egress proxy and the server the daemon dials, enforced by
 *   nftables on the host end. The server's name goes into the box's
 *   `/etc/hosts` (`TNEGA_HOSTS`), as on E2B: the box has no DNS. When a rule
 *   cannot be set, the start fails with `SANDBOX_UNAVAILABLE` and nothing runs.
 * - **Lifecycle.** `start` is idempotent per key; `pause` checkpoints the
 *   sandbox (memory and all) and falls back to stopping it while keeping the
 *   workspace; `start` then restores the checkpoint, or starts cold on the
 *   kept workspace. `stop` removes the box, its upper layer and its
 *   workspace.
 * - **Resources.** cgroup limits from `BoxSpec.resources`, defaulting to
 *   1.5 CPUs, 768 MiB and 512 processes.
 *
 * Needs root on the host, `runsc` (with its `gvisor-bin/` sidecars), `ip`,
 * `nft` and cgroup v2.
 */

export interface GvisorMachineConfig {
  /** The runsc binary. Default `runsc` on PATH. */
  runsc?: string
  /** Box records, bundles and workspaces. Default `/var/lib/tnega/machines`. */
  stateDir?: string
  /** Template root filesystems: `<templatesDir>/<template>/rootfs`. Default `/var/lib/tnega/templates`. */
  templatesDir?: string
  /** runsc's own state (`--root`). Default `/run/tnega-runsc`. */
  runscRoot?: string
  /** gVisor platform. Default `systrap`, which needs no KVM. */
  platform?: 'systrap' | 'ptrace' | 'kvm'
  /** Run a host command (tests). Default: execFile without a shell. */
  exec?: CommandRunner
  /** Replace DNS for the server's name (tests). */
  resolve?: (host: string) => Promise<string[]>
}

export interface CommandResult { code: number; stdout: string; stderr: string }
export type CommandRunner = (command: HostCommand) => Promise<CommandResult>

/** How long output may still arrive after a command exits. */
const OUTPUT_GRACE_MS = 50

/**
 * The default runner: no shell, standard input when given, every exit code
 * reported. It answers on `exit`, not `close`: a detached sandbox keeps the
 * command's output pipes open, so `close` would never come. Output still in
 * flight gets a short grace, then the pipes are let go.
 */
export const runHostCommand: CommandRunner = command => new Promise(done => {
  const child = command.stdio === 'ignore'
    ? spawn(command.command, command.args, { stdio: ['pipe', 'ignore', 'ignore'] })
    : spawn(command.command, command.args, { stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  let finished = false
  const finish = (result: CommandResult): void => {
    if (finished) return
    finished = true
    child.stdout?.destroy()
    child.stderr?.destroy()
    done(result)
  }
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  child.on('error', error => finish({ code: 127, stdout, stderr: stderr || error.message }))
  child.on('close', code => finish({ code: code ?? 1, stdout, stderr }))
  child.on('exit', code => {
    setTimeout(() => finish({ code: code ?? 1, stdout, stderr }), OUTPUT_GRACE_MS)
  })
  // A command that exits without reading its input is not an error here.
  child.stdin?.on('error', () => undefined)
  child.stdin?.end(command.input ?? '')
})

type RecordState = 'running' | 'paused' | 'cold'

/** What the host keeps about one box between calls (`<stateDir>/records/<id>.json`). */
interface BoxRecord {
  version: 1
  key: string
  id: string
  template: string
  specHash: string
  /** `paused`: a checkpoint waits to be restored; `cold`: stopped, workspace kept. */
  state: RecordState
  netIndex: number
  /** The rule the network was made with, so a restore makes the same one. */
  allow: string[] | 'open'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseRecord(text: string): BoxRecord | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined }
  if (!isRecord(value) || value.version !== 1) return undefined
  const { key, id, template, specHash, state, netIndex, allow } = value
  if (typeof key !== 'string' || typeof id !== 'string' || typeof template !== 'string' || typeof specHash !== 'string') return undefined
  if (state !== 'running' && state !== 'paused' && state !== 'cold') return undefined
  if (typeof netIndex !== 'number' || !Number.isInteger(netIndex)) return undefined
  const rule = allow === 'open' ? 'open' : Array.isArray(allow) && allow.every(item => typeof item === 'string') ? allow.filter((item): item is string => typeof item === 'string') : undefined
  if (rule === undefined) return undefined
  return { version: 1, key, id, template, specHash, state, netIndex, allow: rule }
}

const TEMPLATE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/u

/** The box id runsc knows: stable per machine key, safe as a file and link name. */
export function boxId(key: string): string {
  return `tnega-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`
}

async function systemResolve(host: string): Promise<string[]> {
  return (await lookup(host, { all: true, family: 4 })).map(entry => entry.address)
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

export class GvisorMachines extends MachineService {
  readonly kind = 'gvisor'
  private readonly runsc: string
  private readonly stateDir: string
  private readonly templatesDir: string
  private readonly globals: RunscGlobals
  private readonly exec: CommandRunner
  private readonly starting = new Map<string, Promise<unknown>>()
  /** Network indexes are handed out one at a time, so two new boxes never share one. */
  private allocating: Promise<unknown> = Promise.resolve()
  /** Settles once runsc answered `--version`; a host without it starts nothing. */
  private checked: Promise<void> | undefined

  constructor(ctx: Context, private readonly config: GvisorMachineConfig = {}) {
    super(ctx)
    this.runsc = config.runsc ?? 'runsc'
    this.stateDir = config.stateDir ?? '/var/lib/tnega/machines'
    this.templatesDir = config.templatesDir ?? '/var/lib/tnega/templates'
    this.globals = { root: config.runscRoot ?? '/run/tnega-runsc', platform: config.platform ?? 'systrap' }
    this.exec = config.exec ?? runHostCommand
  }

  private paths(id: string, template: string, net: BoxNet, hostWorkspace?: string): BoxPaths {
    const box = join(this.stateDir, 'boxes', id)
    return {
      rootfs: join(this.templatesDir, template, 'rootfs'),
      box,
      bundle: join(box, 'bundle'),
      upper: join(box, 'upper'),
      // The server's own folder when the spec names one: the server's file views then see the box's work.
      workspace: hostWorkspace ?? join(box, 'workspace'),
      checkpoint: join(box, 'checkpoint'),
      log: join(box, 'runsc.log'),
      netns: netnsPath(net),
    }
  }

  private recordFile(id: string): string {
    return join(this.stateDir, 'records', `${id}.json`)
  }

  private async readRecord(id: string): Promise<BoxRecord | undefined> {
    const text = await readFile(this.recordFile(id), 'utf8').catch(() => undefined)
    return text === undefined ? undefined : parseRecord(text)
  }

  private async writeRecord(record: BoxRecord): Promise<void> {
    const file = this.recordFile(record.id)
    await mkdir(join(this.stateDir, 'records'), { recursive: true, mode: 0o700 })
    const temporary = `${file}.tmp`
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, file)
  }

  /**
   * Run `claim` with the lowest free network index and write the record it
   * returns, before another start may look for a free index.
   */
  private claimNetIndex(claim: (netIndex: number) => BoxRecord): Promise<BoxRecord> {
    const claimed = this.allocating.catch(() => undefined).then(async () => {
      const record = claim(await this.freeNetIndex())
      await this.writeRecord(record)
      return record
    })
    this.allocating = claimed
    return claimed
  }

  /** The lowest network index no other box holds. */
  private async freeNetIndex(): Promise<number> {
    const taken = new Set<number>()
    for (const entry of await readdir(join(this.stateDir, 'records')).catch(() => [])) {
      if (!entry.endsWith('.json')) continue
      const record = await this.readRecord(entry.slice(0, -'.json'.length))
      if (record) taken.add(record.netIndex)
    }
    for (let index = 0; index < MAX_BOXES; index += 1) if (!taken.has(index)) return index
    throw new MachineError('this host has no network left for another box', 'MACHINE_FAILED')
  }

  private async run(command: HostCommand, code: 'SANDBOX_UNAVAILABLE' | 'MACHINE_FAILED' = 'MACHINE_FAILED'): Promise<string> {
    const result = await this.exec(command)
    if (result.code !== 0) {
      throw new MachineError(`${command.command} ${command.args.join(' ')} failed (${result.code}): ${result.stderr.trim().slice(0, 300)}`, code)
    }
    return result.stdout
  }

  /** A runsc call that leaves a box running: no pipes, and its log says why when it fails. */
  private async runDetached(args: string[], log: string): Promise<void> {
    await rm(log, { force: true })
    const result = await this.exec(this.runscCommand(args, 'ignore'))
    if (result.code === 0) return
    const logged = await readFile(log, 'utf8').catch(() => '')
    const why = logged.trim().split('\n').slice(-3).join(' ').slice(-300) || `nothing in ${log}`
    throw new MachineError(`runsc could not start the box (exit ${result.code}): ${why}`, 'MACHINE_FAILED')
  }

  private runscCommand(args: string[], stdio?: HostCommand['stdio']): HostCommand {
    return stdio === undefined ? { command: this.runsc, args } : { command: this.runsc, args, stdio }
  }

  /** runsc must answer before anything is made; without it the host has no gVisor. */
  private ensureRunsc(): Promise<void> {
    this.checked ??= (async () => {
      const result = await this.exec(this.runscCommand(['--version']))
      if (result.code !== 0) {
        this.checked = undefined
        throw new MachineError(`runsc is not usable on this host (${result.stderr.trim().slice(0, 200) || `exit ${result.code}`}); install gVisor with its gvisor-bin/ directory`, 'MACHINE_UNAVAILABLE')
      }
    })()
    return this.checked
  }

  async start(key: string, spec: BoxSpec): Promise<MachineRef> {
    validateBoxSpec(spec)
    if (spec.isolation === 'microvm') {
      throw new MachineError('this host runs boxes in gVisor, not microVMs; ask for isolation "gvisor" or use a microVM Provider', 'SANDBOX_UNAVAILABLE')
    }
    if (!TEMPLATE_NAME.test(spec.template)) throw new MachineError(`template ${spec.template} is not a template name`, 'MACHINE_INVALID')
    const previous = this.starting.get(key) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(() => this.startOnce(key, spec))
    this.starting.set(key, run)
    try {
      return await run
    } finally {
      if (this.starting.get(key) === run) this.starting.delete(key)
    }
  }

  private async startOnce(key: string, spec: BoxSpec): Promise<MachineRef> {
    await this.ensureRunsc()
    const id = boxId(key)
    const existing = await this.readRecord(id)
    if (existing && existing.specHash !== (spec.specHash ?? '')) {
      throw new MachineError(`machine ${key} runs an older environment; save its work, stop it and start again`, 'MACHINE_SPEC_CHANGED', { ref: id })
    }
    if (existing?.state === 'running' && await this.runscStatus(id) === 'running') return { ref: id }
    const rootfs = join(this.templatesDir, spec.template, 'rootfs')
    if (!await exists(join(rootfs, 'usr/local/bin/tnega-box-start'))) {
      throw new MachineError(`template ${spec.template} has no root filesystem at ${rootfs}; build it with deploy/gvisor/build-rootfs.sh`, 'MACHINE_INVALID')
    }
    const { env, allow } = await this.network(spec)
    const recordWith = (netIndex: number): BoxRecord => ({ version: 1, key, id, template: spec.template, specHash: spec.specHash ?? '', state: 'running', netIndex, allow })
    // Kept before anything is made, so a failed start can always be undone by stop.
    const netIndex = existing
      ? existing.netIndex
      : (await this.claimNetIndex(index => ({ ...recordWith(index), state: 'cold' }))).netIndex
    const record = recordWith(netIndex)
    if (existing) await this.writeRecord({ ...record, state: existing.state })
    const net = boxNet(id.slice('tnega-'.length), record.netIndex)
    const paths = this.paths(id, spec.template, net, spec.hostWorkspace)
    try {
      await this.clearSandbox(id, net)
      await mkdir(paths.bundle, { recursive: true, mode: 0o700 })
      await mkdir(paths.upper, { recursive: true, mode: 0o700 })
      await mkdir(paths.workspace, { recursive: true, mode: 0o755 })
      await writeFile(join(paths.bundle, 'config.json'), `${JSON.stringify(ociConfig(spec, paths, env, `/tnega/${id}`), null, 2)}\n`, { mode: 0o600 })
      for (const command of networkUp(net, allow)) {
        // A box whose rule did not go in must not run: egress is the only way out.
        await this.run(command, allow === 'open' ? 'MACHINE_FAILED' : 'SANDBOX_UNAVAILABLE')
      }
      const restored = existing?.state === 'paused' && await this.restore(id, paths)
      if (!restored) {
        // The box outlives this call, so it must not inherit our pipes.
        await this.runDetached(runscRun(this.globals, paths, id), paths.log)
      }
    } catch (error) {
      // Nothing half made stays behind: no sandbox, no namespace, no rule. The workspace stays.
      await this.clearSandbox(id, net)
      await this.writeRecord({ ...record, state: 'cold' }).catch(() => undefined)
      throw error instanceof MachineError ? error : new MachineError(`could not start box ${id}: ${error instanceof Error ? error.message : String(error)}`, 'MACHINE_FAILED', { cause: error, ref: id })
    }
    await this.writeRecord(record)
    return { ref: id }
  }

  /** Bring a checkpoint back; `false` when it cannot be, and the box starts cold on its workspace. */
  private async restore(id: string, paths: BoxPaths): Promise<boolean> {
    if (!await exists(paths.checkpoint)) return false
    // A restored box outlives this call too: keep it off our pipes.
    const result = await this.exec(this.runscCommand(runscRestore(this.globals, paths, id), 'ignore'))
    await rm(paths.checkpoint, { recursive: true, force: true })
    if (result.code === 0) return true
    await this.exec(this.runscCommand([...runscGlobals(this.globals), 'delete', '--force', id]))
    return false
  }

  /** Remove the sandbox and its network, whatever state they are in. */
  private async clearSandbox(id: string, net: BoxNet): Promise<void> {
    await this.exec(this.runscCommand([...runscGlobals(this.globals), 'kill', '--all', id, 'KILL']))
    await this.exec(this.runscCommand([...runscGlobals(this.globals), 'delete', '--force', id]))
    for (const command of networkDown(net)) await this.exec(command)
  }

  async pause(ref: string): Promise<void> {
    const record = await this.readRecord(ref)
    if (!record || record.state !== 'running') return
    const net = boxNet(ref.slice('tnega-'.length), record.netIndex)
    const paths = this.paths(ref, record.template, net)
    await rm(paths.checkpoint, { recursive: true, force: true })
    await mkdir(paths.checkpoint, { recursive: true, mode: 0o700 })
    // A checkpoint keeps memory and processes; it stops the sandbox when written.
    const checkpoint = await this.exec(this.runscCommand([...runscGlobals(this.globals), 'checkpoint', '--image-path', paths.checkpoint, ref]))
    if (checkpoint.code !== 0) await rm(paths.checkpoint, { recursive: true, force: true })
    await this.clearSandbox(ref, net)
    await this.writeRecord({ ...record, state: checkpoint.code === 0 ? 'paused' : 'cold' })
  }

  async stop(ref: string): Promise<void> {
    const record = await this.readRecord(ref)
    if (!record) return
    const net = boxNet(ref.slice('tnega-'.length), record.netIndex)
    await this.clearSandbox(ref, net)
    await rm(join(this.stateDir, 'boxes', ref), { recursive: true, force: true })
    await rm(this.recordFile(ref), { force: true })
  }

  async status(ref: string): Promise<MachineState> {
    const record = await this.readRecord(ref)
    if (!record) return 'missing'
    if (record.state !== 'running') return 'paused'
    return this.runscStatus(ref)
  }

  private async runscStatus(id: string): Promise<MachineState> {
    const result = await this.exec(this.runscCommand([...runscGlobals(this.globals), 'state', id]))
    if (result.code !== 0) return 'exited'
    try {
      const state: unknown = JSON.parse(result.stdout)
      if (isRecord(state) && (state.status === 'running' || state.status === 'created')) return 'running'
      if (isRecord(state) && state.status === 'paused') return 'paused'
    } catch {
      // An answer that is not JSON is no running box.
    }
    return 'exited'
  }

  /** The daemon's environment and the box's allowed destinations. */
  private async network(spec: BoxSpec): Promise<{ env: Record<string, string>; allow: string[] | 'open' }> {
    const env = boxEnvironment(spec)
    if (spec.network.mode === 'open') return { env, allow: 'open' }
    const host = new URL(spec.daemon.serverUrl).hostname.replace(/^\[|\]$/gu, '')
    let server: string[]
    if (isIPv4(host)) {
      server = [host]
    } else {
      try {
        server = [...new Set((await (this.config.resolve ?? systemResolve)(host)).filter(address => isIPv4(address)))]
      } catch (error) {
        throw new MachineError(`could not resolve the server ${host}: ${error instanceof Error ? error.message : String(error)}`, 'MACHINE_UNAVAILABLE', { cause: error })
      }
      if (!server.length) throw new MachineError(`the server ${host} has no IPv4 address for the box rule`, 'MACHINE_INVALID')
      env.TNEGA_HOSTS = server.map(address => `${address} ${host}`).join('\n')
    }
    const proxy = spec.network.mode === 'egress' ? spec.network.egress.proxyAddresses : []
    return { env, allow: [...new Set([...proxy, ...server])] }
  }
}

/** What a host offers for boxes, for a deployment check: nothing here starts a box. */
export interface GvisorHostProbe {
  /** Everything a gVisor box needs is here. */
  ready: boolean
  /** One plain line per thing missing. */
  problems: string[]
  /** Whether this host could run microVMs itself (`/dev/kvm`), for the operator's choice. */
  kvm: boolean
}

function execText(command: string, args: string[]): Promise<{ ok: boolean; text: string }> {
  return new Promise(done => {
    execFile(command, args, { timeout: 10_000 }, (error, stdout, stderr) => done({ ok: !error, text: `${stdout}${stderr}` }))
  })
}

/** Where a command runs from: itself when it is a path, else the first match on `PATH`. */
async function locate(command: string, path: string): Promise<string | undefined> {
  if (isAbsolute(command) || command.includes('/')) return await exists(command) ? command : undefined
  for (const dir of path.split(delimiter)) {
    if (dir && await exists(join(dir, command))) return join(dir, command)
  }
  return undefined
}

/**
 * Why runsc's sidecars cannot be found, or `undefined` when they can. The
 * release ships `gvisor-bin/` next to `runsc`; with `runsc` copied alone,
 * `--version` still works but every sandbox fails to start.
 */
export async function missingSidecars(runsc: string, path = process.env.PATH ?? ''): Promise<string | undefined> {
  const found = await locate(runsc, path)
  if (!found) return undefined
  const sidecars = join(dirname(await realpath(found).catch(() => found)), 'gvisor-bin')
  const isDir = await stat(sidecars).then(entry => entry.isDirectory(), () => false)
  return isDir ? undefined : `runsc has no gvisor-bin/ directory beside it (${sidecars}); copy the whole release, not runsc alone`
}

/**
 * Check a host for gVisor boxes: root, runsc with its sidecars, `ip`, `nft`
 * and cgroup v2. Reports `kvm` too, so a deployment can say plainly why a
 * microVM Provider cannot run here, instead of quietly running containers.
 */
export async function probeGvisorHost(config: Pick<GvisorMachineConfig, 'runsc'> = {}): Promise<GvisorHostProbe> {
  const problems: string[] = []
  if (process.platform !== 'linux') problems.push('gVisor boxes need Linux')
  if (process.getuid?.() !== 0) problems.push('the box host must run as root to make namespaces, rules and sandboxes')
  const runsc = await execText(config.runsc ?? 'runsc', ['--version'])
  if (!runsc.ok) problems.push('runsc is missing or broken; install the gVisor release with its gvisor-bin/ directory')
  const sidecars = runsc.ok ? await missingSidecars(config.runsc ?? 'runsc') : undefined
  if (sidecars) problems.push(sidecars)
  if (!(await execText('ip', ['-V'])).ok) problems.push('ip (iproute2) is missing')
  if (!(await execText('nft', ['--version'])).ok) problems.push('nft (nftables) is missing: without it egress cannot be enforced')
  if (!await exists('/sys/fs/cgroup/cgroup.controllers')) problems.push('cgroup v2 is not mounted at /sys/fs/cgroup')
  return { ready: problems.length === 0, problems, kvm: await exists('/dev/kvm') }
}

/** Plugin: provide `ctx.machines` from gVisor. The composition layer mounts it, only on a host that opted in. */
export const machineGvisor = {
  name: 'machine-gvisor',
  apply(ctx: Context, config: GvisorMachineConfig = {}): void {
    new GvisorMachines(ctx, config)
  },
}

export const name = '@tnega/machine-gvisor'
