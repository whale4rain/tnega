import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { Context } from '@tnega/core'
import { tools } from '@tnega/tools'
import { createCodingAgentPlugin } from '../src/index.js'
import { boundedStderr, connectMcpServers, loadMcpConfig } from '../src/mcp.js'

const dirs: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const fixture = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url))

describe('mcp', () => {
  it('loads an empty config when .tnega/mcp.json is missing', async () => {
    const dir = await tempDir('tnega-mcp-empty-')
    expect(await loadMcpConfig(dir)).toEqual({})
  })

  it('connects a stdio server, exposes tools, and disposes cleanly', async () => {
    const dir = await tempDir('tnega-mcp-live-')
    await mkdir(join(dir, '.tnega'), { recursive: true })
    await writeFile(join(dir, '.tnega', 'mcp.json'), JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [fixture],
        },
      },
    }))

    const runtime = await connectMcpServers(dir)
    expect(runtime.surveys).toEqual([
      { name: 'fixture', status: 'connected', toolCount: 1 },
    ])
    expect(runtime.tools).toHaveLength(1)
    expect(runtime.tools[0]?.schema.name).toBe('mcp__fixture__echo')
    expect(runtime.tools[0]?.schema.description).toContain('echo an object back')

    const result = await runtime.tools[0]!.execute({ value: 'hello' }, {})
    expect(result).toEqual({ content: 'echo:hello' })

    await runtime.dispose()
    await expect(runtime.tools[0]!.execute({ value: 'hello' }, {}))
      .rejects.toThrow(/mcp server closed/)
  })

  it('records a failed survey when the server cannot start', async () => {
    const dir = await tempDir('tnega-mcp-fail-')
    await mkdir(join(dir, '.tnega'), { recursive: true })
    await writeFile(join(dir, '.tnega', 'mcp.json'), JSON.stringify({
      mcpServers: {
        broken: {
          command: 'tnega-no-such-server-command',
          stderr: 'ignore',
        },
      },
    }))

    const runtime = await connectMcpServers(dir)
    expect(runtime.surveys[0]).toMatchObject({
      name: 'broken',
      status: 'failed',
      toolCount: 0,
    })
    expect(runtime.tools).toEqual([])
    await runtime.dispose()
  })

  it('keeps the good servers when one fails, and a broken mcp.json costs only the MCP tools', async () => {
    const dir = await tempDir('tnega-mcp-partial-')
    await mkdir(join(dir, '.tnega'), { recursive: true })
    await writeFile(join(dir, '.tnega', 'mcp.json'), JSON.stringify({
      mcpServers: {
        fixture: { command: process.execPath, args: [fixture] },
        broken: { command: 'tnega-no-such-server-command', stderr: 'ignore' },
      },
    }))
    const runtime = await connectMcpServers(dir)
    expect(runtime.surveys.map(survey => [survey.name, survey.status])).toEqual([['fixture', 'connected'], ['broken', 'failed']])
    // The failure did not close the server that started before it.
    expect(await runtime.tools[0]!.execute({ value: 'still here' }, {})).toEqual({ content: 'echo:still here' })
    await runtime.dispose()

    await writeFile(join(dir, '.tnega', 'mcp.json'), '{ not json')
    const broken = await connectMcpServers(dir)
    expect(broken.surveys).toMatchObject([{ name: '.tnega/mcp.json', status: 'failed', toolCount: 0 }])
    expect(broken.tools).toEqual([])
  })

  it('starts a coding session even when its MCP config is broken, and waits for servers on dispose', async () => {
    const dir = await tempDir('tnega-mcp-session-')
    await mkdir(join(dir, '.tnega'), { recursive: true })
    await writeFile(join(dir, '.tnega', 'mcp.json'), '{ not json')
    const root = new Context()
    await root.plugin(tools)
    const fiber = root.plugin(createCodingAgentPlugin({ cwd: dir }))
    await fiber
    expect(root.get('coding')?.survey()).toMatchObject({ mcpEnabled: true, mcpServers: 0, mcpTools: 0 })
    await fiber.dispose()
  })

  it('marks a remote server\'s stderr with its name and stops after a bound', () => {
    const lines: string[] = []
    const write = boundedStderr('db', text => { lines.push(text) }, 20)
    write('first li')
    write('ne\nsecond\n')
    write('x'.repeat(30) + '\n')
    write('never shown\n')
    expect(lines).toEqual(['[mcp db] first line\n', '[mcp db] second\n', '[mcp db] (more output dropped)\n'])
  })
})
