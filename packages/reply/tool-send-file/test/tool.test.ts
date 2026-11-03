import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { tools, type ToolsService } from '@tnega/tools'
import { toolSendFile } from '../src/index.js'

let workspace: string
let outside: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'tnega-send-file-'))
  outside = await mkdtemp(join(tmpdir(), 'tnega-send-file-outside-'))
  await mkdir(join(workspace, 'out'))
  await writeFile(join(workspace, 'out', 'chart.PNG'), Buffer.from([1, 2, 3]))
  await writeFile(join(workspace, 'report.pdf'), 'pdf')
  await writeFile(join(outside, 'secret.txt'), 'no')
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

async function setup() {
  const root = new Context()
  await root.plugin(tools)
  const plugin = root.plugin(toolSendFile, { cwd: workspace })
  await plugin
  return { registry: root.get('tools') as ToolsService, plugin }
}

it('describes the workspace files it hands to the person, images apart from other files', async () => {
  const { registry, plugin } = await setup()
  const result = await registry.execute('send_file', { paths: [join('out', 'chart.PNG'), './report.pdf'] }, {})
  expect(result).toMatchObject({
    ok: true,
    output: { sent: [
      { path: 'out/chart.PNG', name: 'chart.PNG', size: 3, kind: 'image' },
      { path: 'report.pdf', name: 'report.pdf', size: 3, kind: 'file' },
    ] },
  })
  await plugin.dispose()
  expect(registry.list().some(tool => tool.schema.name === 'send_file')).toBe(false)
})

it('refuses files outside the workspace, missing files and folders', async () => {
  const { registry } = await setup()
  await expect(registry.execute('send_file', { paths: [join(outside, 'secret.txt')] }, {})).resolves.toMatchObject({ ok: false, error: { message: expect.stringMatching(/outside the workspace/) } })
  await expect(registry.execute('send_file', { paths: ['nope.png'] }, {})).resolves.toMatchObject({ ok: false, error: { message: expect.stringMatching(/does not exist/) } })
  await expect(registry.execute('send_file', { paths: ['out'] }, {})).resolves.toMatchObject({ ok: false, error: { message: expect.stringMatching(/not a file/) } })
  await expect(registry.execute('send_file', { paths: [] }, {})).resolves.toMatchObject({ ok: false })
})
