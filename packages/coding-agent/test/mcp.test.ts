import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { connectMcpServers, loadMcpConfig } from '../src/mcp.js'

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
})
