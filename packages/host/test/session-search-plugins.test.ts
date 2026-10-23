import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { SqliteSessionIndex } from '@tnega/session-search-sqlite'
import { SESSION_TOOL_NAMES } from '@tnega/tool-session-search'
import { tools } from '@tnega/tools'
import { hostPlugins } from '../src/support.js'

it('mounts the session search tools on every run over the shared index, and removes them with the run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tnega-host-session-search-'))
  const index = new SqliteSessionIndex({ path: join(directory, 'index.sqlite') })
  const run = new Context()
  try {
    await run.plugin(tools)
    const mounted = []
    for (const plugin of hostPlugins({ sessionIndex: index, configFile: join(directory, 'config.json') }, directory)) {
      const fiber = run.plugin(plugin)
      await fiber
      mounted.push(fiber)
    }
    const names = () => run.get('tools').list().map(tool => tool.schema.name)
    expect(names()).toEqual(expect.arrayContaining([...SESSION_TOOL_NAMES]))
    for (const fiber of mounted.reverse()) await fiber.dispose()
    expect(names().some(name => SESSION_TOOL_NAMES.some(tool => tool === name))).toBe(false)
  } finally {
    await index.close()
    await rm(directory, { recursive: true, force: true })
  }
})
