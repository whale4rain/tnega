import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@tnega/core'
import { tools, type ToolsService } from '@tnega/tools'
import { afterEach, describe, expect, it } from 'vitest'

import { createPluginWorkshop, type PluginWorkshop } from '../src/plugin-dev.js'

const dirs: string[] = []
const workshops: PluginWorkshop[] = []

afterEach(async () => {
  await Promise.all(workshops.splice(0).map(workshop => workshop.close()))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-plugin-dev-'))
  dirs.push(dir)
  const workshop = await createPluginWorkshop(dir)
  workshops.push(workshop)
  const root = new Context()
  await root.plugin(tools)
  await root.plugin(workshop.plugin)
  const registry = root.get('tools') as ToolsService
  return { dir, workshop, registry }
}

const shout = (suffix: string) => `
  export default function apply(ctx) {
    ctx.get('tools').register({
      schema: { name: 'shout', description: 'Upper-case text.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
      execute: async input => input.text.toUpperCase() + ${JSON.stringify(suffix)},
    })
  }
`

describe('plugin dev mode', () => {
  it('patches a plugin the agent writes into the running tool registry', async () => {
    const { registry } = await setup()
    expect(registry.has('plugin_write')).toBe(true)
    expect(registry.has('shout')).toBe(false)

    const written = await registry.execute('plugin_write', { name: 'shout', source: shout('!') })
    expect(written.ok).toBe(true)
    expect(written.output).toMatchObject({ ok: true, toolsAdded: ['shout'], plugins: ['shout'] })
    expect((await registry.execute('shout', { text: 'hi' })).output).toBe('HI!')

    // Replacing the source swaps the behaviour in place.
    await registry.execute('plugin_write', { name: 'shout', source: shout('?') })
    expect((await registry.execute('shout', { text: 'hi' })).output).toBe('HI?')
    expect((await registry.execute('plugin_read', { name: 'shout' })).output).toContain('"?"')
  })

  it('rolls a failing plugin back and keeps the previous generation running', async () => {
    const { dir, registry } = await setup()
    await registry.execute('plugin_write', { name: 'shout', source: shout('!') })

    const broken = await registry.execute('plugin_write', { name: 'shout', source: 'export default function apply( {' })
    expect(broken.output).toMatchObject({ ok: false, toolsAdded: [], toolsRemoved: [] })
    expect((await readFile(join(dir, 'shout.mjs'), 'utf8'))).toContain('"!"')
    expect((await registry.execute('shout', { text: 'hi' })).output).toBe('HI!')

    const throwing = await registry.execute('plugin_write', {
      name: 'boom', source: 'export default function apply() { throw new Error("nope") }',
    })
    expect(throwing.output).toMatchObject({ ok: false, error: expect.stringContaining('nope') })
    expect(existsSync(join(dir, 'boom.mjs'))).toBe(false)
    expect((await registry.execute('shout', { text: 'hi' })).output).toBe('HI!')
  })

  it('unloads a removed plugin and refuses names outside the workshop', async () => {
    const { registry } = await setup()
    await registry.execute('plugin_write', { name: 'shout', source: shout('!') })
    const removed = await registry.execute('plugin_remove', { name: 'shout' })
    expect(removed.output).toMatchObject({ ok: true, toolsRemoved: ['shout'], plugins: [] })
    expect(registry.has('shout')).toBe(false)

    const escape = await registry.execute('plugin_write', { name: '../evil', source: shout('!') })
    expect(escape.ok).toBe(false)
    expect(escape.error?.message).toContain('plugin name')
  })

  it('loads plugins already in the directory when it starts', async () => {
    const first = await setup()
    await first.registry.execute('plugin_write', { name: 'shout', source: shout('!') })
    const again = await createPluginWorkshop(first.dir)
    workshops.push(again)
    const root = new Context()
    await root.plugin(tools)
    await root.plugin(again.plugin)
    expect((await (root.get('tools') as ToolsService).execute('shout', { text: 'a' })).output).toBe('A!')
  })
})
