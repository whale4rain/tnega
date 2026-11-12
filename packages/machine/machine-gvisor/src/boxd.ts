import { chmod, chown, lstat, mkdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@tnega/core'
import {
  BOX_ISOLATION_LEVELS,
  MachineError,
  MachineService,
  validateBoxSpec,
  type BoxIsolation,
  type BoxNetwork,
  type BoxResources,
  type BoxSpec,
  type MachineErrorCode,
  type MachineProvider,
  type MachineRef,
  type MachineState,
} from '@tnega/machine'

/**
 * `tnega boxd`: the one root process of a gVisor host (issue #91). The server
 * runs as an ordinary user and asks boxd, over a unix socket, to start,
 * pause, stop or look at a box; boxd alone runs runsc, `ip`, `nft` and the
 * cgroups. A server that is taken over can only start and stop boxes from
 * the templates already on the host, in the folders the operator allowed.
 *
 * The protocol is one JSON object per line, answered by `id`:
 *
 * ```jsonc
 * {"id":1,"method":"start","params":{"key":"<machine row id>","spec":{ … BoxSpec … }}}
 * {"id":2,"method":"pause","params":{"ref":"tnega-0123456789abcdef"}}
 * {"id":1,"result":{"ref":"tnega-0123456789abcdef"}}
 * {"id":2,"error":{"code":"MACHINE_INVALID","message":"…"}}
 * ```
 *
 * boxd trusts nothing the server sends: keys and refs are checked, the spec is
 * parsed field by field and validated again, and a host folder must lie
 * inside a workspace root the operator named and must not belong to root.
 */

export type BoxdMethod = 'start' | 'pause' | 'stop' | 'status'

export const BOXD_METHODS: readonly BoxdMethod[] = ['start', 'pause', 'stop', 'status']

/** The box ids boxd hands out (`boxId`): nothing else is ever passed to runsc. */
export const BOX_REF = /^tnega-[0-9a-f]{16}$/u

export const MAX_KEY_LENGTH = 512

/** A request line longer than this is not a box request; the connection is closed. */
export const MAX_LINE_BYTES = 256 * 1024

const MACHINE_ERROR_CODES: readonly MachineErrorCode[] = ['SANDBOX_UNAVAILABLE', 'MACHINE_UNAVAILABLE', 'MACHINE_INVALID', 'MACHINE_SPEC_CHANGED', 'MACHINE_FAILED']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(message: string): never {
  throw new MachineError(message, 'MACHINE_INVALID')
}

function stringField(value: Record<string, unknown>, name: string): string {
  const field = value[name]
  if (typeof field !== 'string') invalid(`${name} must be a string`)
  return field
}

function optionalString(value: Record<string, unknown>, name: string): string | undefined {
  const field = value[name]
  if (field === undefined) return undefined
  if (typeof field !== 'string') invalid(`${name} must be a string`)
  return field
}

function stringMap(value: unknown, name: string): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) invalid(`${name} must be an object of strings`)
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') invalid(`${name}.${key} must be a string`)
    out[key] = entry
  }
  return out
}

function optionalNumber(value: Record<string, unknown>, name: string): number | undefined {
  const field = value[name]
  if (field === undefined) return undefined
  if (typeof field !== 'number' || !Number.isFinite(field)) invalid(`resources.${name} must be a number`)
  return field
}

function parseResources(value: unknown): BoxResources | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) invalid('resources must be an object')
  const cpus = optionalNumber(value, 'cpus')
  const memoryMb = optionalNumber(value, 'memoryMb')
  const pids = optionalNumber(value, 'pids')
  return {
    ...(cpus === undefined ? {} : { cpus }),
    ...(memoryMb === undefined ? {} : { memoryMb }),
    ...(pids === undefined ? {} : { pids }),
  }
}

function parseNetwork(value: unknown): BoxNetwork {
  if (!isRecord(value)) invalid('network must be an object')
  if (value.mode === 'open') return { mode: 'open' }
  if (value.mode === 'none') return { mode: 'none' }
  if (value.mode !== 'egress') invalid('network.mode must be egress, none or open')
  const egress = value.egress
  if (!isRecord(egress)) invalid('network.egress must be an object')
  const addresses = egress.proxyAddresses
  if (!Array.isArray(addresses)) invalid('network.egress.proxyAddresses must be a list')
  const proxyAddresses = addresses.map(address => typeof address === 'string' ? address : invalid('network.egress.proxyAddresses must be strings'))
  return {
    mode: 'egress',
    egress: {
      proxyUrl: stringField(egress, 'proxyUrl'),
      proxyAddresses,
      token: stringField(egress, 'token'),
      caCertificate: stringField(egress, 'caCertificate'),
    },
  }
}

function parseIsolation(value: unknown): BoxIsolation | undefined {
  if (value === undefined) return undefined
  const level = BOX_ISOLATION_LEVELS.find(entry => entry === value)
  return level ?? invalid(`isolation must be one of ${BOX_ISOLATION_LEVELS.join(', ')}`)
}

/**
 * A {@link BoxSpec} from untrusted JSON: every field read by name and type,
 * unknown fields dropped, then {@link validateBoxSpec}. Throws
 * `MACHINE_INVALID` for anything else.
 */
export function parseBoxSpec(value: unknown): BoxSpec {
  if (!isRecord(value)) invalid('spec must be an object')
  const daemon = value.daemon
  if (!isRecord(daemon)) invalid('spec.daemon must be an object')
  const hostWorkspace = optionalString(value, 'hostWorkspace')
  const env = stringMap(value.env, 'env')
  const resources = parseResources(value.resources)
  const isolation = parseIsolation(value.isolation)
  const labels = stringMap(value.labels, 'labels')
  const specHash = optionalString(value, 'specHash')
  const spec: BoxSpec = {
    template: stringField(value, 'template'),
    daemon: { serverUrl: stringField(daemon, 'serverUrl'), token: stringField(daemon, 'token') },
    workspacePath: stringField(value, 'workspacePath'),
    network: parseNetwork(value.network),
    ...(hostWorkspace === undefined ? {} : { hostWorkspace }),
    ...(env === undefined ? {} : { env }),
    ...(resources === undefined ? {} : { resources }),
    ...(isolation === undefined ? {} : { isolation }),
    ...(labels === undefined ? {} : { labels }),
    ...(specHash === undefined ? {} : { specHash }),
  }
  validateBoxSpec(spec)
  return spec
}

export function assertBoxKey(key: unknown): string {
  if (typeof key !== 'string' || !key.trim() || key.length > MAX_KEY_LENGTH) invalid(`key must be a non-empty string of at most ${MAX_KEY_LENGTH} characters`)
  return key
}

export function assertBoxRef(ref: unknown): string {
  if (typeof ref !== 'string' || !BOX_REF.test(ref)) invalid('ref must be a box id (tnega- and 16 hex digits)')
  return ref
}

function isInside(root: string, path: string): boolean {
  const rest = relative(root, path)
  return rest === '' || (!rest.startsWith(`..${sep}`) && rest !== '..' && !isAbsolute(rest))
}

/**
 * Refuse a host folder boxd may not mount: outside every workspace root (after
 * links are followed), missing, not a folder, or owned by root, since the box
 * would then write as root.
 */
export async function assertHostWorkspace(path: string, roots: readonly string[]): Promise<void> {
  if (!roots.length) invalid('this box host mounts no host folders: start boxd with --workspace-root')
  const real = await realpath(path).catch(() => invalid(`host folder ${path} does not exist`))
  const realRoots = await Promise.all(roots.map(root => realpath(root).catch(() => resolve(root))))
  if (!realRoots.some(root => isInside(root, real))) invalid(`host folder ${path} is outside the workspace roots this box host allows`)
  const entry = await stat(real)
  if (!entry.isDirectory()) invalid(`host folder ${path} is not a folder`)
  if (entry.uid === 0) invalid(`host folder ${path} belongs to root; a box may not write as root`)
}

export interface BoxdOptions {
  /** The unix socket to listen on. */
  socket: string
  /** What runs the boxes: `GvisorMachines` in production. */
  machines: MachineProvider
  /** Folders a box may mount, with everything under them. */
  workspaceRoots: readonly string[]
  /** The group allowed to connect (socket mode 0660, this gid). Without it only root may connect. */
  gid?: number
}

export interface Boxd {
  readonly socket: string
  close(): Promise<void>
}

type Answer = { result: unknown } | { error: { code: MachineErrorCode; message: string; ref?: string } }

function errorAnswer(error: unknown): Answer {
  if (error instanceof MachineError) {
    return { error: { code: error.code, message: error.message, ...(error.ref === undefined ? {} : { ref: error.ref }) } }
  }
  return { error: { code: 'MACHINE_FAILED', message: error instanceof Error ? error.message : String(error) } }
}

async function answer(options: BoxdOptions, method: unknown, params: unknown): Promise<Answer> {
  try {
    const fields = isRecord(params) ? params : invalid('params must be an object')
    switch (method) {
      case 'start': {
        const key = assertBoxKey(fields.key)
        const spec = parseBoxSpec(fields.spec)
        if (spec.hostWorkspace !== undefined) await assertHostWorkspace(spec.hostWorkspace, options.workspaceRoots)
        const ref: MachineRef = await options.machines.start(key, spec)
        return { result: { ref: ref.ref } }
      }
      case 'pause':
        await options.machines.pause(assertBoxRef(fields.ref))
        return { result: {} }
      case 'stop':
        await options.machines.stop(assertBoxRef(fields.ref))
        return { result: {} }
      case 'status':
        return { result: { state: await options.machines.status(assertBoxRef(fields.ref)) } }
      default:
        return invalid(`unknown method; boxd answers ${BOXD_METHODS.join(', ')}`)
    }
  } catch (error) {
    return errorAnswer(error)
  }
}

/** Lines from a socket, at most {@link MAX_LINE_BYTES} each; a longer one ends the connection. */
function onLines(socket: Socket, handle: (line: string) => void): void {
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) handle(line)
      newline = buffer.indexOf('\n')
    }
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) socket.destroy()
  })
}

async function removeStaleSocket(path: string): Promise<void> {
  const entry = await lstat(path).catch(() => undefined)
  if (!entry) return
  if (!entry.isSocket()) throw new Error(`${path} exists and is not a socket; refusing to replace it`)
  // A socket nobody answers on is left from a boxd that did not exit cleanly.
  const live = await new Promise<boolean>(done => {
    const probe = createConnection(path)
    probe.once('connect', () => { probe.destroy(); done(true) })
    probe.once('error', () => done(false))
  })
  if (live) throw new Error(`another boxd is listening on ${path}`)
  await rm(path, { force: true })
}

/** Listen on `options.socket` and serve the four box verbs. */
export async function startBoxd(options: BoxdOptions): Promise<Boxd> {
  const socketPath = resolve(options.socket)
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o755 })
  await removeStaleSocket(socketPath)
  const connections = new Set<Socket>()
  const server: Server = createServer(socket => {
    connections.add(socket)
    socket.on('close', () => connections.delete(socket))
    socket.on('error', () => undefined)
    onLines(socket, line => {
      let request: unknown
      try { request = JSON.parse(line) } catch { request = undefined }
      const id = isRecord(request) && (typeof request.id === 'number' || typeof request.id === 'string') ? request.id : null
      const pending = isRecord(request)
        ? answer(options, request.method, request.params)
        : Promise.resolve(errorAnswer(new MachineError('a request is one JSON object per line', 'MACHINE_INVALID')))
      void pending.then(reply => {
        if (!socket.destroyed) socket.write(`${JSON.stringify({ id, ...reply })}\n`)
      })
    })
  })
  // Nobody but root and the socket's group may connect: a narrow umask closes the gap before chmod.
  const umask = process.umask(0o177)
  try {
    await new Promise<void>((done, fail) => {
      server.once('error', fail)
      server.listen(socketPath, () => { server.off('error', fail); done() })
    })
  } finally {
    process.umask(umask)
  }
  if (options.gid !== undefined) await chown(socketPath, process.getuid?.() ?? 0, options.gid)
  await chmod(socketPath, options.gid === undefined ? 0o600 : 0o660)
  return {
    socket: socketPath,
    async close() {
      for (const socket of connections) socket.destroy()
      await new Promise<void>(done => server.close(() => done()))
      await rm(socketPath, { force: true })
    },
  }
}

/** The gid of a group in `/etc/group`, for `--group`. */
export async function groupId(name: string, file = '/etc/group'): Promise<number> {
  if (/^\d+$/u.test(name)) return Number(name)
  const text = await readFile(file, 'utf8').catch(() => '')
  for (const line of text.split('\n')) {
    const [group, , gid] = line.split(':')
    if (group === name && gid !== undefined && /^\d+$/u.test(gid)) return Number(gid)
  }
  throw new Error(`no group named ${name}; create it with groupadd ${name}`)
}

export interface GvisorClientConfig {
  /** boxd's socket. */
  socket: string
  /** How long one call may take. Default 3 minutes: a start restores a checkpoint. */
  timeoutMs?: number
}

let nextRequestId = 1

/**
 * `ctx.machines` on a server that is not root: every call goes to boxd over
 * its socket. It runs no host command itself.
 */
export class GvisorMachinesClient extends MachineService {
  readonly kind = 'gvisor'

  constructor(ctx: Context, private readonly config: GvisorClientConfig) {
    super(ctx)
  }

  private call(method: BoxdMethod, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = nextRequestId++
    return new Promise((done, fail) => {
      const socket = createConnection(this.config.socket)
      let settled = false
      const finish = (outcome: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        outcome()
      }
      const timer = setTimeout(() => finish(() => fail(new MachineError(`boxd did not answer ${method} within ${Math.round((this.config.timeoutMs ?? 180_000) / 1000)} s`, 'MACHINE_FAILED'))), this.config.timeoutMs ?? 180_000)
      socket.once('error', (error: Error) => finish(() => fail(new MachineError(`cannot reach boxd at ${this.config.socket} (${error.message}); is tnega boxd running, and is this user in its group?`, 'MACHINE_UNAVAILABLE', { cause: error }))))
      socket.once('close', () => finish(() => fail(new MachineError(`boxd closed the connection during ${method}`, 'MACHINE_FAILED'))))
      onLines(socket, line => {
        let reply: unknown
        try { reply = JSON.parse(line) } catch { reply = undefined }
        if (!isRecord(reply) || reply.id !== id) return
        const { error, result } = reply
        if (isRecord(error)) {
          const code = MACHINE_ERROR_CODES.find(entry => entry === error.code) ?? 'MACHINE_FAILED'
          const message = typeof error.message === 'string' ? error.message : 'boxd refused the request'
          const ref = typeof error.ref === 'string' ? error.ref : undefined
          finish(() => fail(new MachineError(message, code, ref === undefined ? undefined : { ref })))
          return
        }
        finish(() => done(isRecord(result) ? result : {}))
      })
      socket.once('connect', () => socket.write(`${JSON.stringify({ id, method, params })}\n`))
    })
  }

  async start(key: string, spec: BoxSpec): Promise<MachineRef> {
    validateBoxSpec(spec)
    const { ref } = await this.call('start', { key, spec })
    if (typeof ref !== 'string') throw new MachineError('boxd answered start without a ref', 'MACHINE_FAILED')
    return { ref }
  }

  async pause(ref: string): Promise<void> {
    await this.call('pause', { ref })
  }

  async stop(ref: string): Promise<void> {
    await this.call('stop', { ref })
  }

  async status(ref: string): Promise<MachineState> {
    const { state } = await this.call('status', { ref })
    if (state === 'running' || state === 'paused' || state === 'exited' || state === 'missing') return state
    throw new MachineError('boxd answered status without a state', 'MACHINE_FAILED')
  }
}
