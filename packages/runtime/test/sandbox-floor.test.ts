import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import type { ExecutionProvider, ShellRequest } from '@tnega/process'
import { runtimeCapabilities } from '../src/compose.js'
import { ESCALATION_REFUSED_NOTE, sandboxedPermission, withoutEscalation } from '../src/sandbox-floor.js'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    // Windows can keep the cwd of a just-exited shell busy for a moment.
    for (let attempt = 0; ; attempt++) {
      try { await rm(dir, { recursive: true, force: true }); break } catch (error) {
        if (attempt >= 5) throw error
        await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)))
      }
    }
  }
})

it('turns bypass into workspace-write and keeps the other levels', () => {
  expect(sandboxedPermission('bypass')).toBe('workspace-write')
  expect(sandboxedPermission('workspace-write')).toBe('workspace-write')
  expect(sandboxedPermission('read-only')).toBe('read-only')
})

it('keeps an approved escalation inside the sandbox and says so', async () => {
  const seen: ShellRequest[] = []
  const inner: ExecutionProvider = {
    runShell: async request => { seen.push(request); return { exitCode: 0, stdout: 'ok', stderr: '' } },
    runProcess: async () => ({ exitCode: 0, stdout: '', stderr: '', stdoutTruncated: false }),
    fetchHttp: async () => ({ status: 200, ok: true, headers: {}, body: '', truncated: false }),
  }
  const provider = withoutEscalation(inner)
  const escalated = await provider.runShell({ command: 'make', cwd: '/w', unsandboxed: true })
  expect(seen[0]?.unsandboxed).toBe(false)
  expect(escalated.stderr).toContain(ESCALATION_REFUSED_NOTE)
  const plain = await provider.runShell({ command: 'ls', cwd: '/w' })
  expect(seen[1]?.unsandboxed).toBeUndefined()
  expect(plain.stderr).toBe('')
})

it('does not let a scope that requires the sandbox write outside its workspace, even at bypass', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-sandbox-floor-'))
  const outside = await mkdtemp(join(tmpdir(), 'tnega-sandbox-floor-outside-'))
  dirs.push(dir, outside)
  const target = join(outside, 'escaped.txt')
  const ctx = new Context()
  const fiber = ctx.plugin(runtimeCapabilities, {
    workspace: dir,
    permission: 'bypass',
    sandboxRequired: true,
    builtin: { allowShell: true },
    search: false, skills: false, office: false,
  })
  await fiber
  try {
    // Confined, or refused where this host has no sandbox (SANDBOX_UNAVAILABLE): never written.
    await ctx.get('tools').execute('shell', { command: `node -e "require('fs').writeFileSync(${JSON.stringify(target).replace(/"/gu, '\'')}, 'x')"` })
    await expect(stat(target)).rejects.toThrow()
  } finally {
    await fiber.dispose()
  }
})
