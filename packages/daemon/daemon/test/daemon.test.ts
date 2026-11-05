import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { RpcErrorCode, acceptDaemon, memoryTransportPair, type DaemonLink, type Transport } from '@tnega/daemon-protocol'
import { fsRemote } from '@tnega/fs-remote'
import { remoteExecutionProvider } from '@tnega/process-remote'
import { assertSecureServerUrl, connectWebSocket, startDaemon } from '../src/index.js'
import { loopbackDaemon } from './loopback.js'

const dirs: string[] = []
const cleanups: Array<() => Promise<void>> = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup().catch(() => undefined)))
  // Windows can keep a just-killed process's cwd busy for a moment.
  for (const dir of dirs.splice(0)) {
    for (let attempt = 0; ; attempt++) {
      try { await rm(dir, { recursive: true, force: true }); break } catch (error) {
        if (attempt >= 5) throw error
        await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)))
      }
    }
  }
})

async function open(workspace: string) {
  const loopback = await loopbackDaemon([workspace])
  cleanups.push(() => loopback.close())
  return { ...loopback, id: loopback.daemon.workspaces[0]!.id }
}

const node = (script: string): string => `node -e "${script}"`

describe('workspace binding', () => {
  it('refuses a workspace the daemon did not announce, by call and at open', async () => {
    const dir = await tempDir('tnega-daemon-')
    const { link } = await open(dir)
    await expect(link.call('fs/stat', { workspaceId: 'ws_other', path: 'a' })).rejects.toMatchObject({ rpcCode: RpcErrorCode.WORKSPACE_DENIED })
    const ctx = new Context()
    await ctx.plugin(fsRemote, { link })
    expect(() => ctx.get('fs').workspace(join(dir, 'elsewhere'))).toThrow(/does not serve/)
  })

  it('fences files and command folders inside the workspace', async () => {
    const dir = await tempDir('tnega-daemon-')
    const outside = await tempDir('tnega-daemon-outside-')
    await writeFile(join(outside, 'secret.txt'), 'no')
    const { link, id } = await open(dir)
    await expect(link.call('fs/read', { workspaceId: id, path: join(outside, 'secret.txt') })).rejects.toMatchObject({ name: 'PathSandboxError' })
    await expect(link.call('process/shell', { workspaceId: id, cwd: outside, command: 'echo hi', sandbox: { mode: 'bypass' } }))
      .rejects.toMatchObject({ name: 'PathSandboxError' })
  })
})

describe('commands', () => {
  it('runs read-only when the runtime sends no sandbox: a write never lands', async () => {
    const dir = await tempDir('tnega-daemon-')
    const { link, id } = await open(dir)
    await link.call('process/shell', {
      workspaceId: id,
      cwd: dir,
      command: node(`require('fs').writeFileSync('written.txt','x')`),
    }).catch(() => undefined)
    await expect(stat(join(dir, 'written.txt'))).rejects.toThrow()
  })

  it('runs a retried call once: the same callId gets the first answer', async () => {
    const dir = await tempDir('tnega-daemon-')
    const { link, id } = await open(dir)
    const call = {
      workspaceId: id,
      callId: 'call-1',
      cwd: dir,
      command: node(`require('fs').appendFileSync('log.txt','x')`),
      sandbox: { mode: 'bypass' as const },
    }
    const first = await link.call('process/shell', call)
    const second = await link.call('process/shell', call)
    expect(second).toEqual(first)
    expect(await readFile(join(dir, 'log.txt'), 'utf8')).toBe('x')
  })

  it('streams output and follows a background process to its exit', async () => {
    const dir = await tempDir('tnega-daemon-')
    const { link, id } = await open(dir)
    const execution = remoteExecutionProvider(link, { workspaceId: id, sandbox: () => ({ mode: 'bypass' }) })
    const chunks: string[] = []
    const result = await execution.runShell({ command: node(`console.log('streamed')`), cwd: dir, onOutput: chunk => chunks.push(chunk.toString()) })
    expect(result.stdout.trim()).toBe('streamed')
    expect(chunks.join('')).toContain('streamed')
    expect(execution.describeShell?.()).toMatch(/Commands run in/)

    const background = await execution.startShell!({ command: node(`console.log('bg');setTimeout(()=>{},50)`), cwd: dir })
    expect(await background.exited).toBe(0)
    expect(background.output()).toContain('bg')
  })

  it('kills its background processes and fails in-flight calls when it stops', async () => {
    const dir = await tempDir('tnega-daemon-')
    const { link, id, daemon } = await open(dir)
    const execution = remoteExecutionProvider(link, { workspaceId: id, sandbox: () => ({ mode: 'bypass' }) })
    const background = await execution.startShell!({ command: node(`setInterval(()=>{},1000)`), cwd: dir })
    const running = execution.runShell({ command: node(`setTimeout(()=>{},60000)`), cwd: dir, timeoutMs: 120_000 })
      .then(() => undefined, (error: unknown) => error)
    await new Promise(resolve => setTimeout(resolve, 100))
    await daemon.close()
    expect(await running).toMatchObject({ rpcCode: RpcErrorCode.CONNECTION_LOST })
    expect(await background.exited).toBeNull()
    expect(daemon.state).toBe('stopped')
  })
})

describe('connection', () => {
  it('dials again after a dropped connection and announces itself again', async () => {
    const dir = await tempDir('tnega-daemon-')
    const links: DaemonLink[] = []
    const accepted: Array<Promise<DaemonLink>> = []
    const connect = (): Transport => {
      const [runtimeSide, daemonSide] = memoryTransportPair()
      accepted.push(acceptDaemon(runtimeSide, { heartbeat: false }).then(link => { links.push(link); return link }))
      return daemonSide
    }
    const daemon = startDaemon({ connect, workspaces: [{ path: dir }], heartbeat: false, reconnect: { minDelayMs: 5, maxDelayMs: 20 } })
    cleanups.push(() => daemon.close())
    await daemon.ready
    const first = await accepted[0]!
    first.close('network blip')
    await new Promise(resolve => setTimeout(resolve, 50))
    const second = await accepted[1]!
    expect(second.workspaces).toEqual(first.workspaces)
    expect(await second.call('fs/stat', { workspaceId: second.workspaces[0]!.id, path: '.' })).toMatchObject({ kind: 'dir' })
  })

  it('stops when the runtime refuses its protocol version', async () => {
    const dir = await tempDir('tnega-daemon-')
    let dials = 0
    const daemon = startDaemon({
      connect: () => {
        dials += 1
        const [runtimeSide, daemonSide] = memoryTransportPair()
        void acceptDaemon(runtimeSide, { heartbeat: false }).catch(() => undefined)
        return daemonSide
      },
      workspaces: [{ path: dir }],
      heartbeat: false,
      reconnect: { minDelayMs: 5, maxDelayMs: 5 },
      protocolVersion: 99,
    })
    await expect(daemon.ready).rejects.toMatchObject({ rpcCode: RpcErrorCode.VERSION_REFUSED })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(dials).toBe(1)
    expect(daemon.state).toBe('stopped')
  })

  it('connects only over wss:// or to this machine, before sending anything', async () => {
    expect(() => assertSecureServerUrl('ws://tnega.example.com/daemon')).toThrow(/refusing ws:/)
    expect(() => assertSecureServerUrl('http://tnega.example.com')).toThrow(/refusing/)
    expect(assertSecureServerUrl('wss://tnega.example.com/daemon').host).toBe('tnega.example.com')
    expect(assertSecureServerUrl('ws://localhost:7777').hostname).toBe('localhost')
    await expect(connectWebSocket('ws://tnega.example.com', { token: 'secret' })).rejects.toThrow(/refusing/)
  })
})
