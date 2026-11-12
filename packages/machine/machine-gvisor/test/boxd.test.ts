import { mkdir, mkdtemp, rm, stat, symlink } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { MachineError, type BoxSpec, type MachineProvider, type MachineState } from '@tnega/machine'
import { boxId, groupId, GvisorMachinesClient, machineGvisor, parseBoxSpec, startBoxd, type Boxd } from '../src/index.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const CA = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n'

function spec(overrides: Partial<BoxSpec> = {}): BoxSpec {
  return {
    template: 'tnega-box',
    daemon: { serverUrl: 'ws://172.28.160.32:4555/daemon', token: 'daemon-token' },
    workspacePath: '/workspace',
    network: { mode: 'egress', egress: { proxyUrl: 'http://172.28.160.32:3128', proxyAddresses: ['172.28.160.32'], token: 'egress-token', caCertificate: CA } },
    isolation: 'gvisor',
    ...overrides,
  }
}

/** Boxes in memory: what boxd would hand to `GvisorMachines`. */
function fakeMachines() {
  const boxes = new Map<string, MachineState>()
  const calls: string[] = []
  const machines: MachineProvider = {
    kind: 'gvisor',
    async start(key, given) {
      calls.push(`start ${key}`)
      if (given.specHash === 'old') throw new MachineError('older environment', 'MACHINE_SPEC_CHANGED', { ref: boxId(key) })
      boxes.set(boxId(key), 'running')
      return { ref: boxId(key) }
    },
    async pause(ref) { calls.push(`pause ${ref}`); if (boxes.has(ref)) boxes.set(ref, 'paused') },
    async stop(ref) { calls.push(`stop ${ref}`); boxes.delete(ref) },
    async status(ref) { return boxes.get(ref) ?? 'missing' },
  }
  return { machines, calls }
}

async function serve(options: { workspaceRoots?: string[]; gid?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'boxd-'))
  const fake = fakeMachines()
  const boxd: Boxd = await startBoxd({ socket: join(dir, 'run', 'boxd.sock'), machines: fake.machines, workspaceRoots: options.workspaceRoots ?? [], ...(options.gid === undefined ? {} : { gid: options.gid }) })
  const scope = new Context()
  cleanups.push(async () => {
    await scope.fiber.dispose()
    await boxd.close()
    await rm(dir, { recursive: true, force: true })
  })
  const client = new GvisorMachinesClient(scope, { socket: boxd.socket, timeoutMs: 5_000 })
  return { dir, boxd, client, ...fake }
}

/** One raw line to boxd, and its answer. */
function raw(socket: string, line: string): Promise<unknown> {
  return new Promise((done, fail) => {
    const connection = createConnection(socket)
    let buffer = ''
    connection.setEncoding('utf8')
    connection.on('data', (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline >= 0) { connection.destroy(); done(JSON.parse(buffer.slice(0, newline))) }
    })
    connection.on('error', fail)
    connection.on('connect', () => connection.write(`${line}\n`))
  })
}

describe('boxd', () => {
  it('starts, pauses, reports and stops a box through the socket', async () => {
    const { client, calls } = await serve()
    const { ref } = await client.start('machine-1', spec())
    expect(ref).toBe(boxId('machine-1'))
    expect(await client.status(ref)).toBe('running')
    await client.pause(ref)
    expect(await client.status(ref)).toBe('paused')
    await client.stop(ref)
    expect(await client.status(ref)).toBe('missing')
    expect(calls).toEqual(['start machine-1', `pause ${ref}`, `stop ${ref}`])
  })

  it('passes the Provider\'s error code and ref back to the server', async () => {
    const { client } = await serve()
    const refused = await client.start('machine-1', spec({ specHash: 'old' })).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(MachineError)
    expect(refused).toMatchObject({ code: 'MACHINE_SPEC_CHANGED', ref: boxId('machine-1') })
  })

  it('refuses a bad ref, a bad key, an unknown verb and a malformed spec with MACHINE_INVALID', async () => {
    const { boxd, client, calls } = await serve()
    await expect(client.stop('../../etc')).rejects.toMatchObject({ code: 'MACHINE_INVALID' })
    await expect(client.status('tnega-xyz')).rejects.toMatchObject({ code: 'MACHINE_INVALID' })
    await expect(client.start('', spec())).rejects.toMatchObject({ code: 'MACHINE_INVALID' })
    await expect(client.start('k'.repeat(513), spec())).rejects.toMatchObject({ code: 'MACHINE_INVALID' })
    expect(await raw(boxd.socket, JSON.stringify({ id: 7, method: 'exec', params: { command: 'sh' } }))).toMatchObject({ id: 7, error: { code: 'MACHINE_INVALID' } })
    expect(await raw(boxd.socket, JSON.stringify({ id: 8, method: 'start', params: { key: 'k', spec: { ...spec(), template: 3 } } }))).toMatchObject({ id: 8, error: { code: 'MACHINE_INVALID' } })
    expect(await raw(boxd.socket, 'not json')).toMatchObject({ id: null, error: { code: 'MACHINE_INVALID' } })
    expect(calls).toEqual([])
  })

  it('mounts host folders only inside a workspace root, never through a link out of it', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'boxd-outside-'))
    const rootDir = await mkdtemp(join(tmpdir(), 'boxd-root-'))
    cleanups.push(() => rm(outside, { recursive: true, force: true }))
    cleanups.push(() => rm(rootDir, { recursive: true, force: true }))
    await mkdir(join(rootDir, 'mia'))
    await symlink(outside, join(rootDir, 'escape'))
    const { client, calls } = await serve({ workspaceRoots: [rootDir] })
    await expect(client.start('outside', spec({ hostWorkspace: outside }))).rejects.toMatchObject({ code: 'MACHINE_INVALID', message: expect.stringMatching(/outside the workspace roots/) })
    await expect(client.start('escape', spec({ hostWorkspace: join(rootDir, 'escape') }))).rejects.toMatchObject({ code: 'MACHINE_INVALID' })
    const owned = (await stat(join(rootDir, 'mia'))).uid === 0
    if (owned) {
      // Run as root (a container): a root-owned folder is refused, since the box would write as root.
      await expect(client.start('mia', spec({ hostWorkspace: join(rootDir, 'mia') }))).rejects.toMatchObject({ message: expect.stringMatching(/belongs to root/) })
    } else {
      await client.start('mia', spec({ hostWorkspace: join(rootDir, 'mia') }))
      expect(calls).toEqual(['start mia'])
    }
  })

  it('refuses every host folder when no workspace root was given', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'boxd-folder-'))
    cleanups.push(() => rm(folder, { recursive: true, force: true }))
    const { client } = await serve()
    await expect(client.start('m', spec({ hostWorkspace: folder }))).rejects.toMatchObject({ code: 'MACHINE_INVALID', message: expect.stringMatching(/--workspace-root/) })
  })

  it.skipIf(process.platform === 'win32')('keeps the socket to its owner, or owner and group when a group is given', async () => {
    const owner = await serve()
    expect((await stat(owner.boxd.socket)).mode & 0o777).toBe(0o600)
    const gid = process.getgid?.() ?? 0
    const grouped = await serve({ gid })
    const entry = await stat(grouped.boxd.socket)
    expect(entry.mode & 0o777).toBe(0o660)
    expect(entry.gid).toBe(gid)
  })

  it('answers MACHINE_UNAVAILABLE when boxd is not there', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'boxd-none-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const scope = new Context()
    cleanups.push(() => scope.fiber.dispose())
    const client = new GvisorMachinesClient(scope, { socket: join(dir, 'missing.sock') })
    await expect(client.status(boxId('m'))).rejects.toMatchObject({ code: 'MACHINE_UNAVAILABLE' })
  })

  it('refuses to start beside a live boxd on the same socket', async () => {
    const { boxd, machines } = await serve()
    await expect(startBoxd({ socket: boxd.socket, machines, workspaceRoots: [] })).rejects.toThrow(/another boxd/)
  })

  it('mounts the client when the plugin is given a socket', async () => {
    const scope = new Context()
    cleanups.push(() => scope.fiber.dispose())
    await scope.plugin(machineGvisor, { socket: '/run/tnega/boxd.sock' })
    expect(scope.get('machines')).toBeInstanceOf(GvisorMachinesClient)
  })

  it('reads a spec field by field and drops what it does not know', () => {
    const parsed = parseBoxSpec(JSON.parse(JSON.stringify({ ...spec(), extra: 'ignored', resources: { cpus: 1 } })))
    expect(parsed).toEqual({ ...spec(), resources: { cpus: 1 } })
    expect(() => parseBoxSpec({ ...spec(), network: { mode: 'egress', egress: { ...spec().network, proxyAddresses: [1] } } })).toThrow(MachineError)
  })

  it('looks up a group id by name or number', async () => {
    expect(await groupId('42')).toBe(42)
    await expect(groupId('no-such-group-here', '/nonexistent')).rejects.toThrow(/groupadd/)
  })
})
