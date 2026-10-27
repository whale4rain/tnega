import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { SecretVault } from '@tnega/secrets-local'
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

const VALUE = 'sk-test-0123456789abcdef'

it('gives shell commands the session secrets and masks them in the result', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-runtime-secrets-'))
  dirs.push(dir)
  const vault = new SecretVault({ file: join(dir, 'secrets.json') })
  const ctx = new Context()
  const fiber = ctx.plugin(runtimeCapabilities, {
    workspace: dir,
    permission: 'bypass',
    builtin: { allowShell: true },
    search: false, skills: false, office: false,
    secrets: { vault, sessionId: 's1' },
  })
  await fiber
  try {
    await ctx.secrets.set('API_KEY', VALUE)
    const result = await ctx.get('tools').execute('shell', {
      command: 'node -e "console.log(process.env.API_KEY.length);console.log(process.env.API_KEY)"',
    })
    expect(result.ok).toBe(true)
    const text = JSON.stringify(result)
    expect(text).toContain(String(VALUE.length))
    expect(text).toContain('[secret: API_KEY]')
    expect(text).not.toContain(VALUE)
    // Another Session in the same vault does not see it.
    expect(await vault.list({ workspace: dir, sessionId: 's2' })).toEqual([])
  } finally {
    await fiber.dispose()
  }
})
