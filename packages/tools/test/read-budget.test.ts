import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { builtinTools, tools, type BuiltinToolsConfig, type ToolsService } from '../src/index.js'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

async function mount(config: BuiltinToolsConfig = {}): Promise<ToolsService> {
  const root = new Context()
  await root.plugin(tools)
  await root.plugin(builtinTools, config)
  return root.get('tools')
}

describe('read_file bounds one result', () => {
  it('clips content to the read byte budget even when the line window would allow more', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tnega-read-budget-'))
    dirs.push(dir)
    const service = await mount({ cwd: dir })
    // 100 lines of 1000 characters: well inside the 2000-line window, far past
    // what one tool result should carry in a prompt.
    const line = 'x'.repeat(1000)
    await writeFile(join(dir, 'wide.txt'), `${Array.from({ length: 100 }, () => line).join('\n')}\n`, 'utf8')

    const result = await service.execute('read_file', { path: 'wide.txt' })
    expect(result.ok).toBe(true)
    const output = result.output as { content: string; truncated: boolean; lines: { total: number } }
    const bytes = Buffer.byteLength(output.content, 'utf8')
    // read_file is exempt from spill, so this is the only bound there is.
    expect(bytes).toBeLessThanOrEqual(51_200)
    expect(output.truncated).toBe(true)
    expect(output.lines.total).toBe(100)
  })

  it('returns a whole small file and says it was not truncated', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tnega-read-budget-small-'))
    dirs.push(dir)
    const service = await mount({ cwd: dir })
    await writeFile(join(dir, 'note.txt'), 'small\nfile\n', 'utf8')

    const result = await service.execute('read_file', { path: 'note.txt' })
    const output = result.output as { content: string; truncated: boolean }
    expect(output.content).toBe('small\nfile\n')
    expect(output.truncated).toBe(false)
  })
})
