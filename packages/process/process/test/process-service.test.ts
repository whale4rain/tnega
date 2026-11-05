import { expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { ProcessBoundary, processBoundary, type ExecutionProvider } from '../src/index.js'

function boundary(extra: Partial<ExecutionProvider> = {}): ExecutionProvider {
  return {
    runShell: async request => ({ exitCode: 0, stdout: `shell:${request.command}`, stderr: '' }),
    runProcess: async request => ({ exitCode: 0, stdout: request.argv.join(' '), stderr: '', stdoutTruncated: false }),
    fetchHttp: async request => ({ status: 200, ok: true, headers: {}, body: request.url, truncated: false }),
    ...extra,
  }
}

it('provides ctx.process from a boundary value and forwards every call', async () => {
  const ctx = new Context()
  const fiber = await ctx.plugin(processBoundary, { boundary: boundary({ describeShell: () => 'Commands run in sh.' }) })
  const process = ctx.get('process')
  expect(await process.runShell({ command: 'ls', cwd: '.' })).toMatchObject({ stdout: 'shell:ls' })
  expect(await process.runProcess({ argv: ['rg', '-n'], cwd: '.' })).toMatchObject({ stdout: 'rg -n' })
  expect(await process.fetchHttp({ url: 'https://example.com' })).toMatchObject({ body: 'https://example.com' })
  expect(process.describeShell?.()).toBe('Commands run in sh.')
  await fiber.dispose()
  expect(ctx.get('process', false)).toBeUndefined()
})

it('has background starts only when the boundary has them', async () => {
  const ctx = new Context()
  const bare = new ProcessBoundary(ctx.isolate('process'), boundary())
  expect(bare.startShell).toBeUndefined()
  expect(bare.startProcess).toBeUndefined()

  const started: string[] = []
  const full = new ProcessBoundary(ctx.isolate('process'), boundary({
    startShell: async request => {
      started.push(request.command)
      return { pid: 1, output: () => '', exitCode: () => 0, exited: Promise.resolve(0), kill: async () => {} }
    },
  }))
  expect(full.startProcess).toBeUndefined()
  await full.startShell?.({ command: 'npm run dev', cwd: '.' })
  expect(started).toEqual(['npm run dev'])
})

it('refuses a second Provider in one scope', async () => {
  const ctx = new Context()
  await ctx.plugin(processBoundary, { boundary: boundary() })
  await expect(ctx.plugin(processBoundary, { boundary: boundary() })).rejects.toThrow()
})
