import { execFile } from 'node:child_process'
import { chmod, chown, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { MachineError, type BoxSpec, type MachineProvider, type MachineState } from '@tnega/machine'
import { boxId, groupId, GvisorMachinesClient, isMountPoint, machineGvisor, parseBoxSpec, pinHostWorkspace, startBoxd, userId, type Boxd } from '../src/index.js'

/** The uid a box folder belongs to in these tests: ours, or a made-up user when the tests run as root. */
const OWNER = (process.getuid?.() ?? 0) === 0 ? 4242 : process.getuid?.() ?? 4242

/** Pinning a host folder means bind mounting it, which only root on Linux can do. */
const CAN_PIN = process.platform === 'linux' && (process.getuid?.() ?? -1) === 0

/** A folder owned by {@link OWNER}. */
async function ownedFolder(path: string): Promise<string> {
  await mkdir(path, { recursive: true })
  if ((process.getuid?.() ?? 0) === 0) await chown(path, OWNER, OWNER)
  return path
}

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
  const seen: { hostWorkspace?: string; ino?: number; uid?: number } = {}
  const hooks: { beforeStart?: () => Promise<void> } = {}
  const machines: MachineProvider = {
    kind: 'gvisor',
    async start(key, given) {
      calls.push(`start ${key}`)
      await hooks.beforeStart?.()
      if (given.hostWorkspace) {
        // What GvisorMachines does: stat the path it was given, then mount it.
        const entry = await stat(given.hostWorkspace)
        Object.assign(seen, { hostWorkspace: given.hostWorkspace, ino: entry.ino, uid: entry.uid })
      }
      if (given.specHash === 'old') throw new MachineError('older environment', 'MACHINE_SPEC_CHANGED', { ref: boxId(key) })
      boxes.set(boxId(key), 'running')
      return { ref: boxId(key) }
    },
    async pause(ref) { calls.push(`pause ${ref}`); if (boxes.has(ref)) boxes.set(ref, 'paused') },
    async stop(ref) { calls.push(`stop ${ref}`); boxes.delete(ref) },
    async status(ref) { return boxes.get(ref) ?? 'missing' },
  }
  return { machines, calls, seen, hooks }
}

async function serve(options: { workspaceRoots?: string[]; owners?: number[]; gid?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'boxd-'))
  const fake = fakeMachines()
  const boxd: Boxd = await startBoxd({
    socket: join(dir, 'run', 'boxd.sock'),
    machines: fake.machines,
    workspaceRoots: options.workspaceRoots ?? [],
    owners: options.owners ?? [OWNER],
    pinRoot: join(dir, 'pins'),
    ...(options.gid === undefined ? {} : { gid: options.gid }),
  })
  const scope = new Context()
  cleanups.push(async () => {
    await scope.fiber.dispose()
    await boxd.close()
    await rm(dir, { recursive: true, force: true })
  })
  const client = new GvisorMachinesClient(scope, { socket: boxd.socket, timeoutMs: 5_000 })
  return { dir, boxd, client, pinRoot: join(dir, 'pins'), ...fake }
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

  it.skipIf(!CAN_PIN)('mounts host folders only strictly inside a workspace root, never through a link out of it', async () => {
    const outside = await ownedFolder(await mkdtemp(join(tmpdir(), 'boxd-outside-')))
    const rootDir = await ownedFolder(await mkdtemp(join(tmpdir(), 'boxd-root-')))
    cleanups.push(() => rm(outside, { recursive: true, force: true }))
    cleanups.push(() => rm(rootDir, { recursive: true, force: true }))
    const mia = await ownedFolder(join(rootDir, 'mia'))
    const checked = (await stat(mia)).ino
    await symlink(outside, join(rootDir, 'escape'))
    const { client, calls, seen, pinRoot } = await serve({ workspaceRoots: [rootDir] })
    await expect(client.start('outside', spec({ hostWorkspace: outside }))).rejects.toMatchObject({ code: 'MACHINE_INVALID', message: expect.stringMatching(/not inside the workspace roots/) })
    await expect(client.start('escape', spec({ hostWorkspace: join(rootDir, 'escape') }))).rejects.toMatchObject({ code: 'MACHINE_INVALID' })
    // The root itself would be every member's folders in one box.
    await expect(client.start('root', spec({ hostWorkspace: rootDir }))).rejects.toMatchObject({ code: 'MACHINE_INVALID' })
    await client.start('mia', spec({ hostWorkspace: mia }))
    expect(calls).toEqual(['start mia'])
    // The Provider is handed a pin under boxd's root, and it is the folder that was checked.
    expect(seen.hostWorkspace?.startsWith(`${pinRoot}${sep}`)).toBe(true)
    expect(seen.ino).toBe(checked)
    expect(seen.uid).toBe(OWNER)
  })

  it.skipIf(!CAN_PIN)('mounts the folder it checked even when the path is swapped for a link to /etc during the start', async () => {
    const rootDir = await ownedFolder(await mkdtemp(join(tmpdir(), 'boxd-race-')))
    cleanups.push(() => rm(rootDir, { recursive: true, force: true }))
    const folder = await ownedFolder(join(rootDir, 'x'))
    const checked = (await stat(folder)).ino
    const { client, seen, hooks } = await serve({ workspaceRoots: [rootDir] })
    // A taken-over server swaps the folder right after the check passes.
    hooks.beforeStart = async () => {
      await rename(folder, join(rootDir, 'moved'))
      await symlink('/etc', folder)
    }
    await client.start('race', spec({ hostWorkspace: folder }))
    expect(seen.ino).toBe(checked)
    expect(seen.uid).toBe(OWNER)
  })

  it.skipIf(!CAN_PIN)('keeps the pin while the box lives and releases it on stop', async () => {
    const rootDir = await ownedFolder(await mkdtemp(join(tmpdir(), 'boxd-pin-')))
    cleanups.push(() => rm(rootDir, { recursive: true, force: true }))
    const folder = await ownedFolder(join(rootDir, 'pin'))
    const { client, seen, pinRoot } = await serve({ workspaceRoots: [rootDir] })
    const { ref } = await client.start('pin', spec({ hostWorkspace: folder }))
    const pin = seen.hostWorkspace!
    expect((await stat(pin)).ino).toBe((await stat(folder)).ino)
    await client.stop(ref)
    expect(await stat(pin).then(() => true, () => false)).toBe(false)
    expect((await readdir(pinRoot)).length).toBe(0)
  })

  it.skipIf(!CAN_PIN)('answers a second start of a running box with the pin it already mounts', async () => {
    const rootDir = await ownedFolder(await mkdtemp(join(tmpdir(), 'boxd-again-')))
    cleanups.push(() => rm(rootDir, { recursive: true, force: true }))
    const folder = await ownedFolder(join(rootDir, 'again'))
    await writeFile(join(folder, 'work.txt'), 'kept')
    const { client, seen, pinRoot } = await serve({ workspaceRoots: [rootDir] })
    const first = await client.start('again', spec({ hostWorkspace: folder }))
    const pin = seen.hostWorkspace!
    // The pool starts a box again when its daemon has not connected yet.
    const second = await client.start('again', spec({ hostWorkspace: folder }))
    expect(second.ref).toBe(first.ref)
    expect(seen.hostWorkspace).toBe(pin)
    expect(await readdir(pinRoot)).toHaveLength(1)
    // The running box still sees its folder through the pin.
    expect(await readFile(join(pin, 'work.txt'), 'utf8')).toBe('kept')
    // Another folder for the same running box is refused, and the live pin stays.
    const other = await ownedFolder(join(rootDir, 'other'))
    await expect(client.start('again', spec({ hostWorkspace: other }))).rejects.toMatchObject({ code: 'MACHINE_INVALID', ref: first.ref })
    expect(await readFile(join(pin, 'work.txt'), 'utf8')).toBe('kept')
    expect(await readdir(pinRoot)).toHaveLength(1)
  })

  it.skipIf(!CAN_PIN)('pins anew when a paused box starts again, and lets go of the old pin', async () => {
    const rootDir = await ownedFolder(await mkdtemp(join(tmpdir(), 'boxd-resume-')))
    cleanups.push(() => rm(rootDir, { recursive: true, force: true }))
    const folder = await ownedFolder(join(rootDir, 'resume'))
    const { client, seen, pinRoot } = await serve({ workspaceRoots: [rootDir] })
    const { ref } = await client.start('resume', spec({ hostWorkspace: folder }))
    const old = seen.hostWorkspace!
    await client.pause(ref)
    await client.start('resume', spec({ hostWorkspace: folder }))
    expect(seen.hostWorkspace).not.toBe(old)
    expect(await readdir(pinRoot)).toEqual([basename(seen.hostWorkspace!)])
  })

  it.skipIf(!CAN_PIN)('makes the pin root a private mount point, and undoes it on close', async () => {
    const { boxd, pinRoot } = await serve()
    expect(await isMountPoint(pinRoot)).toBe(true)
    const line = (await readFile('/proc/self/mountinfo', 'utf8')).split('\n').filter(entry => entry.split(' ')[4] === pinRoot).at(-1)!
    // Optional fields sit between the options and ' - '; a private mount has no shared: or master: tag.
    expect(line.split(' - ')[0]).not.toMatch(/shared:|master:/)
    await boxd.close()
    expect(await isMountPoint(pinRoot)).toBe(false)
  })

  it.skipIf(!CAN_PIN)('never deletes what is behind a pin it could not unmount', async () => {
    const rootDir = await ownedFolder(await mkdtemp(join(tmpdir(), 'boxd-keep-')))
    cleanups.push(() => rm(rootDir, { recursive: true, force: true }))
    const folder = await ownedFolder(join(rootDir, 'keep'))
    const pinRoot = join(rootDir, '..', `${basename(rootDir)}-pins`)
    await mkdir(pinRoot, { mode: 0o700 })
    cleanups.push(() => rm(pinRoot, { recursive: true, force: true }))
    const pinned = await pinHostWorkspace(folder, { roots: [rootDir], owners: [OWNER] }, pinRoot)
    // Stand-in for an unmount that does not take: the folder still has files in it.
    await new Promise<void>((done, fail) => execFile('umount', [pinned.path], error => error ? fail(error) : done()))
    await writeFile(join(pinned.path, 'member.txt'), 'theirs')
    await expect(pinned.close()).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' })
    expect(await readFile(join(pinned.path, 'member.txt'), 'utf8')).toBe('theirs')
  })

  it.skipIf(!CAN_PIN)('leaves a stale pin that still holds files when it starts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'boxd-stale-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const pinRoot = join(dir, 'pins')
    await mkdir(join(pinRoot, 'stale'), { recursive: true, mode: 0o700 })
    await chmod(pinRoot, 0o700)
    await writeFile(join(pinRoot, 'stale', 'member.txt'), 'theirs')
    await mkdir(join(pinRoot, 'empty'), { mode: 0o700 })
    const boxd = await startBoxd({ socket: join(dir, 'run', 'boxd.sock'), machines: fakeMachines().machines, workspaceRoots: [], owners: [OWNER], pinRoot })
    cleanups.push(() => boxd.close())
    expect(await readFile(join(pinRoot, 'stale', 'member.txt'), 'utf8')).toBe('theirs')
    expect((await readdir(pinRoot)).sort()).toEqual(['stale'])
  })

  it('refuses a pin root that overlaps a workspace root', async () => {
    const rootDir = await ownedFolder(await mkdtemp(join(tmpdir(), 'boxd-overlap-')))
    cleanups.push(() => rm(rootDir, { recursive: true, force: true }))
    await expect(startBoxd({
      socket: join(rootDir, 'x.sock'),
      machines: fakeMachines().machines,
      workspaceRoots: [rootDir],
      owners: [OWNER],
      pinRoot: join(rootDir, 'pins'),
    })).rejects.toThrow(/may not overlap/)
  })

  it('refuses a folder of an owner boxd was not told about, and a root-owned one', async () => {
    const rootDir = await ownedFolder(await mkdtemp(join(tmpdir(), 'boxd-owner-')))
    cleanups.push(() => rm(rootDir, { recursive: true, force: true }))
    await ownedFolder(join(rootDir, 'mine'))
    const { client } = await serve({ workspaceRoots: [rootDir], owners: [OWNER + 1] })
    await expect(client.start('m', spec({ hostWorkspace: join(rootDir, 'mine') }))).rejects.toMatchObject({ message: expect.stringMatching(/does not let boxes write as/) })
    if ((process.getuid?.() ?? 0) === 0) {
      await mkdir(join(rootDir, 'roots'))
      await expect(client.start('r', spec({ hostWorkspace: join(rootDir, 'roots') }))).rejects.toMatchObject({ message: expect.stringMatching(/belongs to root/) })
    }
    const otherPinRoot = await mkdtemp(join(tmpdir(), 'boxd-pinroot-'))
    cleanups.push(() => rm(otherPinRoot, { recursive: true, force: true }))
    await expect(startBoxd({ socket: join(rootDir, 'x.sock'), machines: fakeMachines().machines, workspaceRoots: [rootDir], owners: [0], pinRoot: join(otherPinRoot, 'pins') })).rejects.toThrow(/root/)
  })

  it.skipIf(process.platform === 'win32')('refuses a socket folder that others can write to', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'boxd-open-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    await chmod(dir, 0o777)
    await expect(startBoxd({ socket: join(dir, 'boxd.sock'), machines: fakeMachines().machines, workspaceRoots: [], owners: [OWNER], pinRoot: join(dir, 'pins') })).rejects.toThrow(/writable by others/)
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
    const { boxd, machines, dir } = await serve()
    await expect(startBoxd({ socket: boxd.socket, machines, workspaceRoots: [], owners: [OWNER], pinRoot: join(dir, 'second-pins') })).rejects.toThrow(/another boxd/)
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

  it('looks up a group or user id by name or number', async () => {
    expect(await userId('1001')).toBe(1001)
    await expect(userId('no-such-user-here', '/nonexistent')).rejects.toThrow(/no user/)
    expect(await groupId('42')).toBe(42)
    await expect(groupId('no-such-group-here', '/nonexistent')).rejects.toThrow(/groupadd/)
  })
})
