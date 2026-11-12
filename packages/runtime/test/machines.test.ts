import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadEgressRoot, machinesSpecFromEnv } from '../src/machines.js'

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-machines-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const host = (dir: string) => ({ dir, databaseUrl: 'postgresql://x/y', publicUrl: 'https://tnega.example.com' })

describe('boxes from the server settings', () => {
  it('is off unless TNEGA_MACHINE names a Provider, and refuses an unknown one', async () => {
    const dir = await tempDir()
    expect(await machinesSpecFromEnv({}, host(dir))).toBeUndefined()
    expect(await machinesSpecFromEnv({ TNEGA_MACHINE: 'off' }, host(dir))).toBeUndefined()
    await expect(machinesSpecFromEnv({ TNEGA_MACHINE: 'docker' }, host(dir))).rejects.toThrow(/unknown TNEGA_MACHINE/)
  })

  it('puts gVisor boxes on this host: the daemon door and the proxy on the box address, the server folder mounted', async () => {
    const dir = await tempDir()
    const spec = await machinesSpecFromEnv({ TNEGA_MACHINE: 'gvisor', TNEGA_BOX_ADDRESS: '172.16.0.4', TNEGA_BOX_MAX: '2' }, host(dir))
    expect(spec?.provider.kind).toBe('gvisor')
    expect(spec?.gatewayListen).toEqual({ host: '172.16.0.4', port: 7779 })
    expect(spec?.pool).toMatchObject({
      serverUrl: 'ws://172.16.0.4:7779/daemon',
      plainServer: true,
      hostWorkspace: true,
      isolation: 'gvisor',
      network: 'egress',
      maxRunning: 2,
      template: 'tnega-box',
      egress: { listen: { host: '172.16.0.4', port: 7778 }, advertise: '172.16.0.4' },
    })
  })

  it('keeps one egress CA in the server folder, readable by its owner only', async () => {
    const dir = await tempDir()
    const first = await loadEgressRoot(dir)
    const again = await loadEgressRoot(dir)
    expect(again).toEqual(first)
    expect(JSON.parse(await readFile(join(dir, 'egress-ca.json'), 'utf8'))).toEqual(first)
    if (process.platform !== 'win32') expect((await stat(join(dir, 'egress-ca.json'))).mode & 0o777).toBe(0o600)
  })

  it('sends E2B boxes to the public wss:// address and needs its key', async () => {
    const dir = await tempDir()
    await expect(machinesSpecFromEnv({ TNEGA_MACHINE: 'e2b', TNEGA_BOX_ADDRESS: '203.0.113.7' }, host(dir))).rejects.toThrow(/E2B_API_KEY/)
    const spec = await machinesSpecFromEnv({ TNEGA_MACHINE: 'e2b', E2B_API_KEY: 'e2b_x', TNEGA_BOX_ADDRESS: '203.0.113.7', TNEGA_BOX_NETWORK: 'none' }, host(dir))
    expect(spec?.pool).toMatchObject({ serverUrl: 'wss://tnega.example.com/daemon', hostWorkspace: false, isolation: 'microvm', network: 'none' })
    expect(spec?.gatewayListen).toBeUndefined()
    await expect(machinesSpecFromEnv({ TNEGA_MACHINE: 'e2b', E2B_API_KEY: 'k', TNEGA_BOX_ADDRESS: '203.0.113.7' }, { ...host(dir), publicUrl: 'http://localhost:7777' }))
      .rejects.toThrow(/https/)
  })
})
