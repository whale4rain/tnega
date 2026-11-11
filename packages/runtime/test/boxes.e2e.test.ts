/**
 * Milestone 3 on a real host: a gVisor box started by the pool dials the
 * server's daemon door, and the run's link reaches into it. Runs only with
 * `TNEGA_GVISOR_TEMPLATE` (the template name under /var/lib/tnega/templates),
 * as root, with runsc, ip and nft (see docs/test/try-boxes.md). Set
 * `TNEGA_BOX_ADDRESS` when the host's first private IPv4 is not the right one.
 */
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { accountsPg } from '@tnega/accounts-pg'
import type { DaemonLink } from '@tnega/daemon-protocol'
import { daemonGateway } from '@tnega/daemon-gateway'
import { daemons } from '@tnega/daemons'
import { machineGvisor } from '@tnega/machine-gvisor'
import { machinePool, type MachinePool } from '@tnega/machine-pool'
import { webServer } from '@tnega/web-kit'
import { hostPrivateAddress, machinesSpecFromEnv } from '../src/machines.js'

const template = process.env.TNEGA_GVISOR_TEMPLATE
const runnable = Boolean(template) && process.platform === 'linux' && process.getuid?.() === 0

let db: PGlite
let dir: string
let workspace: string
let accountId = ''
let scope: Context | undefined

async function openServer(): Promise<MachinePool> {
  scope = new Context()
  await scope.plugin(webServer)
  await scope.plugin(accountsPg, { sql: db })
  const spec = await machinesSpecFromEnv({
    TNEGA_MACHINE: 'gvisor',
    TNEGA_BOX_TEMPLATE: template ?? '',
    TNEGA_BOX_ADDRESS: process.env.TNEGA_BOX_ADDRESS ?? hostPrivateAddress() ?? '',
  }, { dir, databaseUrl: 'unused' })
  if (!spec) throw new Error('no box spec')
  // What `machinesCapability` mounts, with the test's database in place of a URL.
  await scope.plugin(daemons)
  await scope.plugin(daemonGateway, spec.gatewayListen ? { listen: spec.gatewayListen } : {})
  await scope.plugin(machineGvisor, {})
  await scope.plugin(machinePool, { ...spec.pool, sql: db, egress: spec.pool.egress ? { ...spec.pool.egress, allow: ['example.com'] } : undefined })
  return scope.get('machinePool')
}

async function sh(link: DaemonLink, command: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const workspaceId = link.workspaces[0]?.id ?? ''
  return await link.call('process/shell', { workspaceId, cwd: '/workspace', command, sandbox: { mode: 'bypass' }, timeoutMs: 30_000 })
}

describe.skipIf(!runnable)('boxes on a real host (gVisor)', () => {
  let pool: MachinePool
  let machineId = ''

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tnega-boxes-e2e-'))
    workspace = join(dir, 'members', 'mia')
    db = new PGlite()
    pool = await openServer()
    const accounts = scope?.get('accounts')
    accountId = (await accounts?.createAccount({ login: 'mia', role: 'member', password: 'correct horse battery' }))?.id ?? ''
  }, 120_000)

  afterAll(async () => {
    if (machineId) await pool.stop(machineId).catch(() => undefined)
    await scope?.fiber.dispose()
    await db?.close()
    await rm(dir, { recursive: true, force: true })
  }, 60_000)

  it('runs the session in a gVisor box with nothing of the host in it', async () => {
    const started = Date.now()
    const lease = await pool.acquire({ accountId, workspace, sessionId: 's1' })
    machineId = lease.machineId
    console.log(`box ready with its daemon connected in ${Date.now() - started} ms`)
    expect((await sh(lease.link, 'uname -a')).stdout).toMatch(/gvisor/i)
    expect((await sh(lease.link, 'ls -A /home')).stdout.trim()).toBe('')
    expect((await sh(lease.link, 'hostname')).stdout.trim()).toBe('tnega-box')
    const env = (await sh(lease.link, 'env')).stdout
    expect(env).not.toMatch(/DEEPSEEK_API_KEY|TNEGA_MASTER_KEY|DATABASE_URL|TNEGA_DAEMON_TOKEN/)
    await sh(lease.link, 'echo hello > /tmp/tnega-e2e-marker')
    expect(existsSync('/tmp/tnega-e2e-marker')).toBe(false)
    // The workspace is the server's own folder.
    await sh(lease.link, 'echo from-the-box > /workspace/note.txt')
    expect(await readdir(workspace)).toContain('note.txt')
    lease.release()
  }, 180_000)

  it('lets the box out only through the proxy, and only to allowed hosts', async () => {
    const lease = await pool.acquire({ accountId, workspace })
    const direct = await sh(lease.link, 'curl -sS --noproxy "*" -m 5 -o /dev/null -w "%{http_code}" http://1.1.1.1/ || echo blocked')
    expect(direct.stdout).toMatch(/blocked/)
    const allowed = await sh(lease.link, 'curl -sS -m 20 -o /dev/null -w "%{http_code}" https://example.com/')
    expect(allowed.stdout.trim()).toMatch(/^[23]\d\d$/)
    const refused = await sh(lease.link, 'curl -sS -m 20 -o /dev/null -w "%{http_code}" https://www.wikipedia.org/ || echo refused')
    expect(refused.stdout).toMatch(/refused|403/)
    lease.release()
  }, 120_000)

  it('keeps the box when the server restarts: its daemon dials the new one', async () => {
    const before = await pool.acquire({ accountId, workspace })
    const deviceId = before.deviceId
    before.release()
    await scope?.fiber.dispose()
    pool = await openServer()
    const after = await pool.acquire({ accountId, workspace, sessionId: 's1' })
    expect(after.machineId).toBe(machineId)
    expect(after.deviceId).toBe(deviceId)
    expect((await sh(after.link, 'cat /workspace/note.txt')).stdout.trim()).toBe('from-the-box')
    after.release()
  }, 180_000)

  it('pauses and resumes with the processes still there', async () => {
    const lease = await pool.acquire({ accountId, workspace })
    await sh(lease.link, 'nohup sleep 600 >/dev/null 2>&1 & echo started')
    lease.release()
    const paused = Date.now()
    await pool.pause(machineId)
    console.log(`pause took ${Date.now() - paused} ms`)
    const resumed = Date.now()
    const back = await pool.acquire({ accountId, workspace })
    console.log(`resume with the daemon back took ${Date.now() - resumed} ms`)
    expect((await sh(back.link, 'pgrep -x sleep || true')).stdout.trim()).not.toBe('')
    back.release()
  }, 180_000)
})
