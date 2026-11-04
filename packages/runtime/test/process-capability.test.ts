import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { ProcessBoundary } from '@tnega/process'
import { localExecutionProvider } from '@tnega/process-local'
import { runtimeCapabilities } from '../src/compose.js'

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

it('provides ctx.process as the decorated chain, never the raw local boundary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-runtime-process-'))
  dirs.push(dir)
  const ctx = new Context()
  const fiber = ctx.plugin(runtimeCapabilities, {
    workspace: dir,
    permission: 'read-only',
    builtin: { allowShell: true },
    search: false, skills: false, office: false,
  })
  await fiber
  try {
    const provided = ctx.get('process')
    expect(provided).toBeInstanceOf(ProcessBoundary)
    expect((provided as ProcessBoundary).boundary).not.toBe(localExecutionProvider)
    expect(provided.describeShell?.()).toBe(localExecutionProvider.describeShell?.())

    // Under read-only the command is confined or refused (no mechanism on this
    // host: SANDBOX_UNAVAILABLE); either way it never writes.
    const target = join(dir, 'written.txt')
    await ctx.get('tools').execute('shell', { command: 'node -e "require(\'fs\').writeFileSync(\'written.txt\', \'x\')"' })
    await expect(stat(target)).rejects.toThrow()
  } finally {
    await fiber.dispose()
  }
  expect(ctx.get('process', false)).toBeUndefined()
})
