import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import type { BoxSpec } from '@tnega/machine'
import { GvisorMachines, probeGvisorHost, runscGlobals } from '../src/index.js'

/**
 * Host layer: a real gVisor box. Needs root, runsc, ip, nft, cgroup v2 and a
 * template built with deploy/gvisor/build-rootfs.sh; set TNEGA_GVISOR_TEMPLATE
 * to its name. TNEGA_GVISOR_ALLOWED names an address the box may reach
 * (default the documentation address the daemon dials, which never answers).
 */
const template = process.env.TNEGA_GVISOR_TEMPLATE
const probe = template ? await probeGvisorHost() : undefined
const ready = Boolean(template && probe?.ready)
const stateDir = '/var/lib/tnega/machines'
const machines = new GvisorMachines(new Context(), { stateDir })
const refs: string[] = []

afterAll(async () => {
  for (const ref of refs) await machines.stop(ref)
})

function spec(): BoxSpec {
  return {
    template: template ?? 'tnega-box',
    daemon: { serverUrl: 'ws://192.0.2.1:4555/daemon', token: randomBytes(16).toString('hex') },
    workspacePath: '/workspace',
    network: { mode: 'none' },
    isolation: 'gvisor',
    specHash: 'e2e',
  }
}

/** Run a command inside the box through runsc. */
function inBox(ref: string, ...command: string[]): { ok: boolean; text: string } {
  try {
    const text = execFileSync('runsc', [...runscGlobals({ root: '/run/tnega-runsc', platform: 'systrap' }), 'exec', ref, ...command], { encoding: 'utf8', timeout: 30_000 })
    return { ok: true, text }
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error) }
  }
}

describe.skipIf(!ready)('a real gVisor box', () => {
  it('runs on the sentry, keeps an uncommitted file over pause and resume, and stays out of the host', async () => {
    const key = `e2e-${Date.now()}`
    const { ref } = await machines.start(key, spec())
    refs.push(ref)
    expect(inBox(ref, 'uname', '-r').text).toMatch(/gvisor|4\.4|4\.19/u)
    // The host's home folders and the store are not in the box.
    expect(inBox(ref, 'ls', '/home').text.trim()).toBe('')
    expect(inBox(ref, 'ls', stateDir).ok).toBe(false)
    // No route out but the server address: a direct connection fails.
    expect(inBox(ref, 'curl', '-sS', '-m', '5', 'http://1.1.1.1').ok).toBe(false)
    // No model key or daemon token in what the agent's commands see.
    expect(inBox(ref, 'sh', '-c', 'cat /proc/self/environ | tr "\\0" "\\n"').text).not.toContain('DEEPSEEK_API_KEY')

    const workspace = join(stateDir, 'boxes', ref, 'workspace')
    await writeFile(join(workspace, 'notes.txt'), 'not committed')
    await machines.pause(ref)
    expect(await machines.status(ref)).toBe('paused')
    expect((await machines.start(key, spec())).ref).toBe(ref)
    expect(await machines.status(ref)).toBe('running')
    expect(inBox(ref, 'cat', '/workspace/notes.txt').text).toBe('not committed')
    expect(await readFile(join(workspace, 'notes.txt'), 'utf8')).toBe('not committed')
  }, 120_000)

  it('refuses a microVM box on this host', async () => {
    await expect(machines.start(`e2e-vm-${Date.now()}`, { ...spec(), isolation: 'microvm' })).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' })
  })
})
