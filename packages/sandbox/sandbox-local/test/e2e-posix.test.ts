import { spawn, spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { canonicalPath, resolveSandboxPolicy, type SandboxNetworkRequest } from '@tnega/sandbox'
import { LocalSandboxService, type SandboxRunnerName } from '../src/index.js'

/**
 * 真实机制的端到端验证：探测通过的机制才跑。
 *
 * 本机（Windows）上 bwrap / landlock / sandbox-exec 都不可用，整组跳过；在有对应
 * 二进制与内核支持的 Linux/macOS 机器（CI）上会真的执行受限命令。断言刻意只用
 * **跨机制一致**的结论（只读拒写、工作区可写、stdout 与退出码原样），机制特有的
 * 方言归 `test/local.test.ts` 的 argv 契约。
 */

async function selectorFor(chain: readonly SandboxRunnerName[]): Promise<string | undefined> {
  const ctx = new Context()
  const service = new LocalSandboxService(ctx, { workspaceRoot: canonicalPath(tmpdir()), chain })
  try {
    const status = await service.status()
    return status.available ? status.runner : undefined
  } finally {
    await ctx.fiber.dispose()
  }
}

const bwrap = await selectorFor(['bwrap'])
const landlock = await selectorFor(['landlock'])
const teardown: string[] = []

afterAll(async () => {
  for (const path of teardown) await rm(path, { recursive: true, force: true }).catch(() => undefined)
})

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-sbx-e2e-'))
  teardown.push(dir)
  return dir
}

async function run(
  chain: readonly SandboxRunnerName[],
  dir: string,
  mode: 'read-only' | 'workspace-write',
  command: string,
) {
  const ctx = new Context()
  const service = new LocalSandboxService(ctx, { workspaceRoot: canonicalPath(dir), chain })
  try {
    const confined = await service.confine({
      op: 'shell',
      argv: ['/bin/sh', '-c', command],
      policy: resolveSandboxPolicy({ mode, workspaceRoot: canonicalPath(dir) }),
    })
    const [program, ...args] = confined.argv
    if (program === undefined) throw new Error('confined argv must name a runner')
    // The command runs where the shell tool would run it: in the workspace.
    const result = spawnSync(program, args, { cwd: dir, encoding: 'utf8', timeout: 30_000 })
    return { confined, result }
  } finally {
    await ctx.fiber.dispose()
  }
}

describe.skipIf(bwrap === undefined || process.platform !== 'linux')('bwrap end to end', () => {
  it('refuses every write in read-only mode while reads still work', async () => {
    const dir = await workspace()
    await writeFile(join(dir, 'existing.txt'), 'readable', 'utf8')

    const { result } = await run(['bwrap'], dir, 'read-only', 'cat existing.txt; echo x > new.txt')

    expect(result.stdout).toContain('readable')
    expect(result.status).not.toBe(0)
    expect(existsSync(join(dir, 'new.txt'))).toBe(false)
  })

  it('allows writes inside the workspace in workspace-write mode and hides the host /tmp', async () => {
    const dir = await workspace()
    const hostMarker = join(tmpdir(), `tnega-sbx-host-${Date.now()}.txt`)
    await writeFile(hostMarker, 'host-only-marker', 'utf8')
    teardown.push(hostMarker)

    const { result } = await run(
      ['bwrap'],
      dir,
      'workspace-write',
      `echo inside > inside.txt; cat ${hostMarker} 2>&1; exit 0`,
    )

    expect(existsSync(join(dir, 'inside.txt'))).toBe(true)
    // bwrap 的 workspace-write 给的是随进程消失的 tmpfs /tmp：宿主那个文件不可见。
    expect(result.stdout).not.toContain('host-only-marker')
  })

  it('mirrors the exit code of the confined child unchanged', async () => {
    const dir = await workspace()
    const { result } = await run(['bwrap'], dir, 'workspace-write', 'exit 42')
    expect(result.status).toBe(42)
  })
})

describe.skipIf(landlock === undefined || process.platform !== 'linux')('landlock end to end', () => {
  it('refuses every write in read-only mode while reads still work', async () => {
    const dir = await workspace()
    await writeFile(join(dir, 'existing.txt'), 'readable', 'utf8')

    const { result } = await run(['landlock'], dir, 'read-only', 'cat existing.txt; echo x > new.txt')

    expect(result.stdout).toContain('readable')
    expect(result.status).not.toBe(0)
    expect(existsSync(join(dir, 'new.txt'))).toBe(false)
  })

  it('allows writes inside the workspace in workspace-write mode', async () => {
    const dir = await workspace()
    const { result } = await run(['landlock'], dir, 'workspace-write', 'echo inside > inside.txt')

    expect(result.status).toBe(0)
    expect(existsSync(join(dir, 'inside.txt'))).toBe(true)
  })
})

describe.skipIf(process.platform !== 'linux')('mechanism reporting', () => {
  it('reports the mechanism it actually selected, or none at all', () => {
    const selected = bwrap ?? landlock
    if (selected === undefined) {
      expect(bwrap).toBeUndefined()
      expect(landlock).toBeUndefined()
      return
    }
    expect(['bwrap', 'landlock']).toContain(selected)
  })
})

const socat = spawnSync('socat', ['-V'], { stdio: 'ignore' }).status === 0
const curl = spawnSync('curl', ['--version'], { stdio: 'ignore' }).status === 0

/** A host-side HTTP origin on loopback, which the confined command can only reach through the proxy. */
async function origin(): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => res.end(`origin ${req.url ?? ''}`))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

/** Run a command under a network policy; asynchronous so the in-process proxy can answer. */
async function runNetworked(dir: string, network: SandboxNetworkRequest, command: string) {
  const ctx = new Context()
  // No upstream: the test origin is on this machine, whatever proxy the host uses.
  const service = new LocalSandboxService(ctx, { workspaceRoot: canonicalPath(dir), chain: ['bwrap'], upstreamProxy: () => '' })
  try {
    const confined = await service.confine({
      op: 'shell',
      argv: ['/bin/sh', '-c', command],
      policy: resolveSandboxPolicy({ mode: 'workspace-write', workspaceRoot: canonicalPath(dir), network }),
    })
    const [program, ...args] = confined.argv
    if (program === undefined) throw new Error('confined argv must name a runner')
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(program, args, { cwd: dir, env: { ...process.env, ...confined.env } })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      child.once('error', reject)
      child.once('close', status => resolve({ status, stdout, stderr }))
    })
    return { confined, result, note: confined.annotate?.() }
  } finally {
    await ctx.fiber.dispose()
  }
}

describe.skipIf(bwrap === undefined || !socat || !curl || process.platform !== 'linux')('bwrap network end to end', () => {
  it('reaches an allowed host only through the filtering proxy and explains a blocked one', async () => {
    const dir = await workspace()
    const server = await origin()
    try {
      const { confined, result, note } = await runNetworked(dir, { mode: 'allowlist', allowedDomains: ['127.0.0.1'] },
        // --noproxy '' overrides NO_PROXY so the loopback origin goes through the proxy.
        `curl -sS --noproxy '' --max-time 10 http://127.0.0.1:${server.port}/allowed; echo; `
        + `curl -sS --noproxy '' --max-time 10 -o /dev/null -w '%{http_code}' http://127.0.0.2:${server.port}/blocked; echo; `
        + `curl -sS --noproxy '*' --max-time 5 http://127.0.0.1:${server.port}/direct || echo direct-failed`)

      expect(confined.argv).toContain('--unshare-net')
      expect(confined.env?.HTTPS_PROXY).toBe('http://127.0.0.1:3128')
      expect(result.stdout).toContain('origin /allowed')
      expect(result.stdout).toContain('403')
      // Without the proxy the command has no route to the host's loopback.
      expect(result.stdout).toContain('direct-failed')
      expect(result.stdout).not.toContain('origin /direct')
      expect(note).toContain(`127.0.0.2:${server.port} (not in the allowed domains)`)
    } finally {
      await server.close()
    }
  })

  it('mirrors the exit code through the relay wrapper', async () => {
    const dir = await workspace()
    const { result } = await runNetworked(dir, { mode: 'allowlist', allowedDomains: ['example.com'] }, 'exit 7')
    expect(result.status).toBe(7)
  })

  it('has no network at all when network is off', async () => {
    const dir = await workspace()
    const server = await origin()
    try {
      const { confined, result, note } = await runNetworked(dir, { mode: 'off' },
        `curl -sS --max-time 5 http://127.0.0.1:${server.port}/ || echo no-network`)
      expect(confined.env?.HTTPS_PROXY).toBeUndefined()
      expect(result.stdout).toContain('no-network')
      expect(note).toBeUndefined()
    } finally {
      await server.close()
    }
  })
})
