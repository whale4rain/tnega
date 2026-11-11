import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { MachineError, type BoxSpec } from '@tnega/machine'
import {
  boxId,
  boxNet,
  GvisorMachines,
  missingSidecars,
  nftRuleset,
  runHostCommand,
  ociConfig,
  type CommandResult,
  type HostCommand,
} from '../src/index.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
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

/** A stand-in for runsc, ip, nft and sysctl: records each command and keeps the sandboxes runsc would. */
function fakeHost(options: { runsc?: boolean; failOn?: (command: HostCommand) => boolean; checkpoint?: boolean; runLogs?: string } = {}) {
  const commands: HostCommand[] = []
  const sandboxes = new Map<string, 'running'>()
  const exec = async (command: HostCommand): Promise<CommandResult> => {
    commands.push(command)
    const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' })
    const fail = (stderr: string): CommandResult => ({ code: 1, stdout: '', stderr })
    if (options.failOn?.(command)) return fail('refused')
    if (command.command !== 'runsc') return ok()
    if (options.runsc === false) return { code: 127, stdout: '', stderr: 'spawn runsc ENOENT' }
    const args = command.args
    const verb = args.find(arg => ['--version', 'run', 'state', 'kill', 'delete', 'checkpoint', 'restore'].includes(arg))
    const id = args.at(-1) === 'KILL' ? args.at(-2) ?? '' : args.at(-1) ?? ''
    switch (verb) {
      case '--version': return ok('runsc version release-20261102.0\n')
      case 'run': {
        if (options.runLogs === undefined) { sandboxes.set(id, 'running'); return ok() }
        // A failed detached start: nothing on our streams, the reason in runsc's log.
        await writeFile(args[args.indexOf('--log') + 1] ?? '', options.runLogs)
        return { code: 128, stdout: '', stderr: '' }
      }
      case 'restore': sandboxes.set(id, 'running'); return ok()
      case 'state': return sandboxes.has(id) ? ok(JSON.stringify({ id, status: sandboxes.get(id) })) : fail('no such container')
      case 'kill': return sandboxes.has(id) ? ok() : fail('no such container')
      case 'delete': sandboxes.delete(id); return ok()
      case 'checkpoint': if (options.checkpoint === false) return fail('checkpoint is not supported'); sandboxes.delete(id); return ok()
      default: return fail(`unexpected ${args.join(' ')}`)
    }
  }
  return { exec, commands, sandboxes }
}

async function host(options: Parameters<typeof fakeHost>[0] = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tnega-gvisor-'))
  dirs.push(root)
  const templatesDir = join(root, 'templates')
  await mkdir(join(templatesDir, 'tnega-box', 'rootfs', 'usr/local/bin'), { recursive: true })
  await writeFile(join(templatesDir, 'tnega-box', 'rootfs', 'usr/local/bin/tnega-box-start'), '#!/bin/sh\n')
  const fake = fakeHost(options)
  const machines = new GvisorMachines(new Context(), { stateDir: join(root, 'state'), templatesDir, runscRoot: join(root, 'runsc'), exec: fake.exec, resolve: async () => ['203.0.113.7'] })
  return { ...fake, machines, root }
}

const line = (command: HostCommand) => [command.command, ...command.args].join(' ')

describe('gVisor machines', () => {
  it('starts a box: rules first, then the sandbox, with the daemon settings in its config', async () => {
    const { machines, commands, root } = await host()
    const { ref } = await machines.start('machine-1', spec())
    expect(ref).toBe(boxId('machine-1'))
    const run = commands.map(line)
    const nft = run.findIndex(text => text.startsWith('nft -f -'))
    const create = run.findIndex(text => text.includes(' run --detach '))
    expect(nft).toBeGreaterThan(-1)
    expect(create).toBeGreaterThan(nft)
    expect(run[create]).toContain('--network sandbox')
    expect(run[create]).toContain(`--overlay2 root:dir=${join(root, 'state', 'boxes', ref, 'upper')}`)
    // One detached call: `runsc start` would wait in the foreground.
    expect(run.some(text => text.includes(' start '))).toBe(false)
    const config: unknown = JSON.parse(await readFile(join(root, 'state', 'boxes', ref, 'bundle', 'config.json'), 'utf8'))
    expect(config).toMatchObject({
      process: { args: ['/usr/local/bin/tnega-box-start'], noNewPrivileges: true, capabilities: { bounding: [] } },
      linux: { resources: { memory: { limit: 768 * 1024 * 1024 }, cpu: { quota: 150_000, period: 100_000 }, pids: { limit: 512 } } },
    })
    const env = JSON.stringify(config)
    expect(env).toContain('TNEGA_DAEMON_TOKEN=daemon-token')
    expect(env).toContain('HTTPS_PROXY=http://box:egress-token@172.28.160.32:3128')
    expect(await machines.status(ref)).toBe('running')
  })

  it('allows only the proxy and the server through the host rule, and masquerades the rest', async () => {
    const { machines, commands } = await host()
    await machines.start('machine-1', spec({ daemon: { serverUrl: 'wss://tnega.example.com/daemon', token: 't' } }))
    const rules = commands.find(command => command.command === 'nft' && command.args[0] === '-f')?.input ?? ''
    expect(rules).toContain('ip daddr { 172.28.160.32, 203.0.113.7 } accept')
    expect(rules).toMatch(/iifname "tg[0-9a-f]{8}h" drop/)
  })

  it('writes an open rule only when the box asks for an open network', () => {
    const net = boxNet('0123456789ab', 3)
    expect(net).toMatchObject({ hostAddress: '10.88.0.13', boxAddress: '10.88.0.14', hostLink: 'tg01234567h' })
    expect(nftRuleset(net, 'open')).not.toContain('drop')
    expect(nftRuleset(net, [])).toContain('drop')
    expect(nftRuleset(net, [])).not.toContain('ip daddr {')
  })

  it('refuses a microVM box instead of giving it gVisor', async () => {
    const { machines, commands } = await host()
    await expect(machines.start('machine-1', spec({ isolation: 'microvm' }))).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' })
    expect(commands).toEqual([])
  })

  it('answers MACHINE_UNAVAILABLE without making anything on a host without runsc', async () => {
    const { machines, commands } = await host({ runsc: false })
    await expect(machines.start('machine-1', spec())).rejects.toMatchObject({ code: 'MACHINE_UNAVAILABLE' })
    expect(commands.map(line)).toEqual(['runsc --version'])
  })

  it('fails closed when the egress rule cannot be set: no sandbox, no namespace left', async () => {
    const { machines, commands, sandboxes } = await host({ failOn: command => command.command === 'nft' && command.args[0] === '-f' })
    await expect(machines.start('machine-1', spec())).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' })
    expect(commands.some(command => command.args.includes('run'))).toBe(false)
    expect(sandboxes.size).toBe(0)
    expect(commands.map(line).at(-1)).toMatch(/^ip netns delete tnega-/)
  })

  it('returns the same box for the same key, and refuses one built from another spec', async () => {
    const { machines, commands } = await host()
    const first = await machines.start('machine-1', spec({ specHash: 'a' }))
    const creates = () => commands.filter(command => command.args.includes('run')).length
    expect(await machines.start('machine-1', spec({ specHash: 'a' }))).toEqual(first)
    expect(creates()).toBe(1)
    const refused = await machines.start('machine-1', spec({ specHash: 'b' })).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(MachineError)
    expect(refused).toMatchObject({ code: 'MACHINE_SPEC_CHANGED', ref: first.ref })
  })

  it('pauses with a checkpoint and restores it on the next start', async () => {
    const { machines, commands } = await host()
    const { ref } = await machines.start('machine-1', spec())
    await machines.pause(ref)
    expect(await machines.status(ref)).toBe('paused')
    await machines.start('machine-1', spec())
    expect(commands.some(command => command.args.includes('restore'))).toBe(true)
    expect(await machines.status(ref)).toBe('running')
  })

  it('pauses cold when checkpointing fails, and starts again on the kept workspace', async () => {
    const { machines, commands, root } = await host({ checkpoint: false })
    const { ref } = await machines.start('machine-1', spec())
    const workspace = join(root, 'state', 'boxes', ref, 'workspace')
    await writeFile(join(workspace, 'notes.txt'), 'not committed')
    await machines.pause(ref)
    expect(await machines.status(ref)).toBe('paused')
    await machines.start('machine-1', spec())
    expect(commands.filter(command => command.args.includes('run'))).toHaveLength(2)
    expect(await readFile(join(workspace, 'notes.txt'), 'utf8')).toBe('not committed')
  })

  it('gives boxes started at the same time networks of their own', async () => {
    const { machines, root } = await host()
    const refs = await Promise.all(['member-a', 'member-b', 'member-c'].map(key => machines.start(key, spec())))
    const indexes = await Promise.all(refs.map(async ({ ref }) => {
      const record: unknown = JSON.parse(await readFile(join(root, 'state', 'records', `${ref}.json`), 'utf8'))
      return typeof record === 'object' && record !== null && 'netIndex' in record ? record.netIndex : undefined
    }))
    expect(new Set(indexes).size).toBe(3)
  })

  it('stops a box with its workspace, and answers missing afterwards', async () => {
    const { machines, root } = await host()
    const { ref } = await machines.start('machine-1', spec())
    await machines.stop(ref)
    expect(await machines.status(ref)).toBe('missing')
    await expect(readFile(join(root, 'state', 'boxes', ref, 'bundle', 'config.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    // Gone already is fine.
    await machines.stop(ref)
    await machines.pause(ref)
  })

  it('mounts a host folder as the workspace when asked, and stopping the box keeps that folder', async () => {
    const { machines, root } = await host()
    const folder = join(root, 'members', 'mia')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'work.txt'), 'kept')
    const { ref } = await machines.start('machine-1', spec({ hostWorkspace: folder }))
    const config = await readFile(join(root, 'state', 'boxes', ref, 'bundle', 'config.json'), 'utf8')
    expect(JSON.stringify(JSON.parse(config))).toContain(`"destination":"/workspace","type":"bind","source":${JSON.stringify(folder)}`)
    await machines.stop(ref)
    expect(await readFile(join(folder, 'work.txt'), 'utf8')).toBe('kept')
  })

  it('says why a detached start failed, from runsc\'s log', async () => {
    const { machines } = await host({ runLogs: 'W1111 starting\nE1111 creating container: cannot read client sync file\n' })
    await expect(machines.start('machine-1', spec())).rejects.toThrow(/cannot read client sync file/u)
  })

  it('refuses a template without a root filesystem', async () => {
    const { machines } = await host()
    await expect(machines.start('machine-1', spec({ template: 'missing' }))).rejects.toMatchObject({ code: 'MACHINE_INVALID' })
    await expect(machines.start('machine-1', spec({ template: '../etc' }))).rejects.toMatchObject({ code: 'MACHINE_INVALID' })
  })

  it('maps resources into the cgroup and mounts the workspace', () => {
    const paths = { rootfs: '/t/rootfs', box: '/b', bundle: '/b/bundle', upper: '/b/upper', workspace: '/b/workspace', checkpoint: '/b/cp', log: '/b/runsc.log', netns: '/var/run/netns/x' }
    const config = ociConfig(spec({ resources: { cpus: 1, memoryMb: 512, pids: 64 } }), paths, {}, '/tnega/x')
    expect(config).toMatchObject({
      root: { path: '/t/rootfs' },
      linux: { cgroupsPath: '/tnega/x', resources: { memory: { limit: 512 * 1024 * 1024 }, cpu: { quota: 100_000 }, pids: { limit: 64 } } },
    })
    expect(JSON.stringify(config)).toContain('"destination":"/workspace","type":"bind","source":"/b/workspace"')
    expect(JSON.stringify(config)).toContain('"path":"/var/run/netns/x"')
  })
})

describe.skipIf(process.platform === 'win32')('the host command runner', () => {
  it('answers when the command exits, even if something it started keeps its output open', async () => {
    const started = Date.now()
    // The background sleep holds stdout open the way a detached sandbox does.
    const result = await runHostCommand({ command: 'sh', args: ['-c', 'sleep 5 & echo up'] })
    expect(result).toMatchObject({ code: 0, stdout: 'up\n' })
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it('never lets the box hold our pipes: a detached start is spawned with its output ignored', async () => {
    const { machines, commands } = await host()
    await machines.start('machine-1', spec())
    const run = commands.find(command => command.args.includes('run'))
    expect(run).toMatchObject({ stdio: 'ignore' })
    // Everything that ends with the command keeps its output, so failures stay readable.
    expect(commands.find(command => command.args.includes('state'))?.stdio).toBeUndefined()
  })
})

describe.skipIf(process.platform === 'win32')('the sidecar check', () => {
  it('finds gvisor-bin beside runsc, through a link and on PATH', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tnega-gvisor-bin-'))
    dirs.push(root)
    const release = join(root, 'release')
    const bin = join(root, 'bin')
    await mkdir(join(release, 'gvisor-bin'), { recursive: true })
    await mkdir(bin)
    await writeFile(join(release, 'runsc'), '#!/bin/sh\n')
    await chmod(join(release, 'runsc'), 0o755)
    await symlink(join(release, 'runsc'), join(bin, 'runsc'))
    expect(await missingSidecars('runsc', bin)).toBeUndefined()
    expect(await missingSidecars(join(release, 'runsc'))).toBeUndefined()
  })

  it('says so when runsc was copied alone', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'tnega-runsc-alone-'))
    dirs.push(bin)
    await writeFile(join(bin, 'runsc'), '#!/bin/sh\n')
    expect(await missingSidecars('runsc', bin)).toContain('gvisor-bin')
  })
})
