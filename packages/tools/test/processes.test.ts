import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { Context } from '@tnega/core'

import { builtinTools, localUrls, stripAnsi, tools, type ToolsService } from '../src/index.js'

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
    const started = await registry.execute('process_start', { command: `node -e "${script.replaceAll('"', '\\"')}"` }, {})
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

  it('are absent without shell access', async () => {
    const root = new Context()
    await root.plugin(tools)
    await root.plugin(builtinTools, { cwd: tmpdir() })
    expect((root.get('tools') as ToolsService).list().some(tool => tool.schema.name === 'process_start')).toBe(false)
  })
})
