import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { canonicalPath, resolveSandboxPolicy } from '@tnega/sandbox'
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
    const result = spawnSync(program, args, { encoding: 'utf8', timeout: 30_000 })
    return { confined, result }
  } finally {
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
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
    await writeFile(hostMarker, 'host', 'utf8')
    teardown.push(hostMarker)

    const { result } = await run(
      ['bwrap'],
      dir,
      'workspace-write',
      `echo inside > inside.txt; cat ${hostMarker} 2>&1; exit 0`,
    )

    expect(existsSync(join(dir, 'inside.txt'))).toBe(true)
    // bwrap 的 workspace-write 给的是随进程消失的 tmpfs /tmp：宿主那个文件不可见。
    expect(result.stdout).not.toContain('host')
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
