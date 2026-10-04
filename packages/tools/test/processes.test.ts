import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { Context } from '@tnega/core'

import { builtinTools, localUrls, ProcessRegistry, stripAnsi, tools, type ToolsService } from '../src/index.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('localUrls', () => {
  it('finds dev server URLs through colour codes and rewrites 0.0.0.0', () => {
    const vite = '\u001b[32m  ➜  Local:\u001b[39m   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m\n  ➜  Network: http://0.0.0.0:5173/'
    expect(stripAnsi(vite)).toContain('http://localhost:5173/')
    expect(localUrls(vite)).toEqual(['http://localhost:5173/'])
    expect(localUrls('ready on http://127.0.0.1:3000.')).toEqual(['http://127.0.0.1:3000'])
    expect(localUrls('see https://example.com')).toEqual([])
  })
})

describe('process tools', () => {
  it('start a background command, report its URL, read new output and stop it on dispose', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tnega-process-'))
    dirs.push(cwd)
    const root = new Context()
    await root.plugin(tools)
    const fiber = await root.plugin(builtinTools, { cwd, allowShell: true })
    const registry = root.get('tools') as ToolsService
    const script = 'console.log("ready at http://localhost:4321/"); setInterval(() => console.log("tick"), 100)'
    // A script file keeps the command free of quoting that differs between shells.
    await writeFile(join(cwd, 'server.cjs'), script)
    const started = await registry.execute('process_start', { command: 'node server.cjs' }, {})
    expect(started.ok).toBe(true)
    expect(started.output).toMatchObject({ id: 'p1', status: 'running', urls: ['http://localhost:4321/'] })

    await new Promise(resolve => setTimeout(resolve, 350))
    const more = await registry.execute('process_output', { id: 'p1' }, {})
    expect(String((more.output as { output: string }).output)).toContain('tick')
    expect(String((more.output as { output: string }).output)).not.toContain('ready at')

    const listed = await registry.execute('process_list', {}, {})
    expect(listed.output).toMatchObject([{ id: 'p1', status: 'running' }])

    const stopped = await registry.execute('process_stop', { id: 'p1' }, {})
    expect((stopped.output as { status: string }).status).not.toBe('running')
    await fiber.dispose()
  }, 30_000)

  it('keep processes in a shared registry alive across runs until the registry is disposed', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tnega-process-'))
    dirs.push(cwd)
    const registry = new ProcessRegistry()
    const run = async () => {
      const root = new Context()
      await root.plugin(tools)
      const fiber = await root.plugin(builtinTools, { cwd, allowShell: true, processes: registry })
      return { registry: root.get('tools') as ToolsService, fiber }
    }
    const first = await run()
    await first.registry.execute('process_start', { command: 'node -e "setInterval(() => {}, 1000)"', waitForUrlMs: 0 }, {})
    await first.fiber.dispose()

    const second = await run()
    const listed = await second.registry.execute('process_list', {}, {})
    expect(listed.output).toMatchObject([{ id: 'p1', status: 'running' }])
    await second.fiber.dispose()
    await registry.dispose()
    expect(registry.running()).toHaveLength(0)
  }, 30_000)

  it('are absent without shell access', async () => {
    const root = new Context()
    await root.plugin(tools)
    await root.plugin(builtinTools, { cwd: tmpdir() })
    expect((root.get('tools') as ToolsService).list().some(tool => tool.schema.name === 'process_start')).toBe(false)
  })
})

describe('process tools under the Windows sandbox', () => {
  it.runIf(process.platform === 'win32')('warn that a confined server can fail later, and point at escalation once it does', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tnega-process-'))
    dirs.push(cwd)
    let output = 'VITE ready\n  Local: http://localhost:5199/\n'
    const requests: Array<{ unsandboxed?: boolean }> = []
    const fake = {
      runShell: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runProcess: async () => ({ exitCode: 0, stdout: '', stderr: '', stdoutTruncated: false }),
      fetchHttp: async () => ({ status: 200, ok: true, headers: {}, body: '', truncated: false }),
      startShell: async (request: { unsandboxed?: boolean }) => {
        requests.push(request)
        return {
          pid: 1,
          sandboxed: request.unsandboxed !== true,
          output: () => output,
          exitCode: () => undefined,
          exited: new Promise<number | null>(() => {}),
          kill: async () => {},
        }
      },
      startProcess: async () => { throw new Error('unused') },
    }
    const root = new Context()
    await root.plugin(tools)
    const fiber = await root.plugin(builtinTools, { cwd, allowShell: true, execution: fake })
    const registry = root.get('tools') as ToolsService

    const started = await registry.execute('process_start', { command: 'npm run dev', waitForUrlMs: 0 }, {})
    expect((started.output as { note?: string }).note).toMatch(/spawn EPERM/)

    output += '[vite] Internal server error: spawn EPERM\n'
    const read = await registry.execute('process_output', { id: 'p1' }, {})
    expect((read.output as { hint?: string }).hint).toMatch(/escalate: true/)

    // Escalation only takes effect on an approved call.
    await registry.execute('process_start', { command: 'npm run dev', waitForUrlMs: 0, escalate: true }, {})
    await registry.execute('process_start', { command: 'npm run dev', waitForUrlMs: 0, escalate: true }, { approvedElevation: true })
    expect(requests.map(request => request.unsandboxed === true)).toEqual([false, false, true])
    await fiber.dispose()
  })
})
