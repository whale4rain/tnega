import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import {
  builtinTools,
  forgetObservations,
  tools,
  type BuiltinToolsConfig,
  type ToolResult,
  type ToolsService,
} from '../src/index.js'

const dirs: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  forgetObservations()
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }).catch(() => undefined)))
})

async function mount(config: BuiltinToolsConfig = {}): Promise<ToolsService> {
  const root = new Context()
  await root.plugin(tools)
  await root.plugin(builtinTools, config)
  return (root as unknown as { tools: ToolsService }).tools
}

async function ok(service: ToolsService, name: string, input: unknown, agentId?: string): Promise<Record<string, unknown>> {
  const result: ToolResult = await service.execute(name, input, agentId ? { agentId } : {})
  if (!result.ok) throw new Error(`${name} failed: ${result.error?.message}`)
  return result.output as Record<string, unknown>
}

async function fail(service: ToolsService, name: string, input: unknown, agentId?: string): Promise<ToolResult> {
  const result: ToolResult = await service.execute(name, input, agentId ? { agentId } : {})
  if (result.ok) throw new Error(`${name} unexpectedly succeeded`)
  return result
}

describe('read_file pages by line', () => {
  it('returns a window with the line range it read', async () => {
    const dir = await tempDir('tnega-fs-read-')
    const service = await mount({ cwd: dir })
    await writeFile(join(dir, 'rows.txt'), ['one', 'two', 'three', 'four', 'five'].join('\n'), 'utf8')

    const page = await ok(service, 'read_file', { path: 'rows.txt', offset: 2, limit: 2 })
    expect(page.content).toBe('two\nthree')
    expect(page.lines).toEqual({ start: 2, end: 3, total: 5 })
    expect(page.truncated).toBe(true)

    const whole = await ok(service, 'read_file', { path: 'rows.txt' })
    expect(whole.content).toBe('one\ntwo\nthree\nfour\nfive')
    expect(whole.lines).toEqual({ start: 1, end: 5, total: 5 })
    expect(whole.truncated).toBe(false)
  })

  it('clips one very long line and says how many were clipped', async () => {
    const dir = await tempDir('tnega-fs-read-clip-')
    const service = await mount({ cwd: dir, maxLineChars: 5 })
    await writeFile(join(dir, 'wide.txt'), `${'x'.repeat(50)}\nshort`, 'utf8')

    const page = await ok(service, 'read_file', { path: 'wide.txt' })
    expect(page.clippedLines).toBe(1)
    expect(String(page.content).split('\n')[0]).toBe('xxxxx')
    expect(page.truncated).toBe(true)
  })

  it('reports a file past the whole-file limit as a prefix that does not authorize a write', async () => {
    const dir = await tempDir('tnega-fs-read-escape-')
    const service = await mount({ cwd: dir, fsGuard: 'enforce' })
    await writeFile(join(dir, 'note.txt'), 'hello', 'utf8')
    // Reading it is what authorizes the guarded write below.
    await ok(service, 'read_file', { path: 'note.txt' })
    await ok(service, 'write_file', { path: 'note.txt', content: 'hello again' })
    expect(await readFile(join(dir, 'note.txt'), 'utf8')).toBe('hello again')
  })
})

describe('edit_file', () => {
  it('applies several unique edits at once', async () => {
    const dir = await tempDir('tnega-fs-edit-')
    const service = await mount({ cwd: dir })
    await writeFile(join(dir, 'code.ts'), 'const a = 1\nconst b = 2\nconst c = 3\n', 'utf8')

    const result = await ok(service, 'edit_file', {
      path: 'code.ts',
      edits: [
        { old_string: 'const a = 1', new_string: 'const a = 10' },
        { old_string: 'const c = 3', new_string: 'const c = 30' },
      ],
    })
    expect(result.path).toBe('code.ts')
    expect(result.edits).toEqual([{ line: 1 }, { line: 3 }])
    expect(await readFile(join(dir, 'code.ts'), 'utf8')).toBe('const a = 10\nconst b = 2\nconst c = 30\n')
  })

  it('refuses an ambiguous match and leaves the file untouched', async () => {
    const dir = await tempDir('tnega-fs-edit-ambiguous-')
    const service = await mount({ cwd: dir })
    await writeFile(join(dir, 'code.ts'), 'same\nother\nsame\n', 'utf8')

    const result = await fail(service, 'edit_file', {
      path: 'code.ts',
      edits: [{ old_string: 'same', new_string: 'different' }],
    })
    expect(result.error?.message).toContain('2 times')
    expect(result.error?.message).toContain('lines 1, 3')
    expect(await readFile(join(dir, 'code.ts'), 'utf8')).toBe('same\nother\nsame\n')
  })

  it('refuses text that is not there and points at write_file', async () => {
    const dir = await tempDir('tnega-fs-edit-missing-')
    const service = await mount({ cwd: dir })
    await writeFile(join(dir, 'code.ts'), 'alpha\n', 'utf8')

    const result = await fail(service, 'edit_file', {
      path: 'code.ts',
      edits: [{ old_string: 'beta', new_string: 'gamma' }],
    })
    expect(result.error?.message).toContain('did not appear verbatim')
    expect(result.error?.message).toContain('write_file')
  })

  it('replaces every occurrence when asked', async () => {
    const dir = await tempDir('tnega-fs-edit-all-')
    const service = await mount({ cwd: dir })
    await writeFile(join(dir, 'code.ts'), 'x\nx\nx\n', 'utf8')

    await ok(service, 'edit_file', {
      path: 'code.ts',
      edits: [{ old_string: 'x', new_string: 'y', replace_all: true }],
    })
    expect(await readFile(join(dir, 'code.ts'), 'utf8')).toBe('y\ny\ny\n')
  })

  it('refuses overlapping edits instead of guessing', async () => {
    const dir = await tempDir('tnega-fs-edit-overlap-')
    const service = await mount({ cwd: dir })
    await writeFile(join(dir, 'code.ts'), 'abcdef\n', 'utf8')

    const result = await fail(service, 'edit_file', {
      path: 'code.ts',
      edits: [
        { old_string: 'abc', new_string: 'X' },
        { old_string: 'bcd', new_string: 'Y' },
      ],
    })
    expect(result.error?.message).toContain('overlap')
    expect(await readFile(join(dir, 'code.ts'), 'utf8')).toBe('abcdef\n')
  })

  it('serialises concurrent edits of one file instead of losing one', async () => {
    const dir = await tempDir('tnega-fs-edit-lock-')
    const service = await mount({ cwd: dir })
    await writeFile(join(dir, 'code.ts'), 'a\nb\nc\n', 'utf8')

    await Promise.all([
      ok(service, 'edit_file', { path: 'code.ts', edits: [{ old_string: 'a', new_string: 'A' }] }),
      ok(service, 'edit_file', { path: 'code.ts', edits: [{ old_string: 'c', new_string: 'C' }] }),
    ])
    expect(await readFile(join(dir, 'code.ts'), 'utf8')).toBe('A\nb\nC\n')
  })

  it('leaves no staging directory behind', async () => {
    const dir = await tempDir('tnega-fs-atomic-')
    const service = await mount({ cwd: dir })
    await writeFile(join(dir, 'code.ts'), 'one\n', 'utf8')

    await ok(service, 'edit_file', { path: 'code.ts', edits: [{ old_string: 'one', new_string: 'two' }] })
    await ok(service, 'write_file', { path: 'code.ts', content: 'three\n' })
    expect(await readdir(dir)).toEqual(['code.ts'])
  })
})

describe('concurrency declarations', () => {
  it('declares reads safe and mutations exclusive', async () => {
    const service = await mount({ cwd: await tempDir('tnega-fs-concurrency-') })
    const byName = new Map(service.list().map(tool => [tool.schema.name, tool]))
    // A declaration is what the scheduler groups on: dropping it here silently
    // serialises every read again.
    expect(byName.get('read_file')?.isConcurrencySafe?.({ path: 'a' })).toBe(true)
    expect(byName.get('write_file')?.isConcurrencySafe).toBeUndefined()
    expect(byName.get('edit_file')?.isConcurrencySafe).toBeUndefined()
    // A read that records an observation is still safe: two reads of one path
    // write the same version.
    expect(byName.get('list_dir')?.isConcurrencySafe?.({ path: '.' })).toBe(true)
  })
})

describe('fsGuard modes', () => {
  it('warns but writes when the target was never read', async () => {
    const dir = await tempDir('tnega-fs-guard-warn-')
    const service = await mount({ cwd: dir })
    await writeFile(join(dir, 'note.txt'), 'old', 'utf8')

    const written = await ok(service, 'write_file', { path: 'note.txt', content: 'new' })
    expect(String(written.warning)).toContain('was not read in this session')
    expect(await readFile(join(dir, 'note.txt'), 'utf8')).toBe('new')
  })

  it('refuses an unread target in enforce mode', async () => {
    const dir = await tempDir('tnega-fs-guard-enforce-')
    const service = await mount({ cwd: dir, fsGuard: 'enforce' })
    await writeFile(join(dir, 'note.txt'), 'old', 'utf8')

    const result = await fail(service, 'write_file', { path: 'note.txt', content: 'new' })
    expect(result.error?.message).toContain('has not been read in this session')
    expect(await readFile(join(dir, 'note.txt'), 'utf8')).toBe('old')
  })

  it('refuses a target that changed since it was read, naming the new version', async () => {
    const dir = await tempDir('tnega-fs-guard-stale-')
    const service = await mount({ cwd: dir, fsGuard: 'enforce' })
    await writeFile(join(dir, 'note.txt'), 'first', 'utf8')
    await ok(service, 'read_file', { path: 'note.txt' })
    // Something else writes it between the read and the write.
    await writeFile(join(dir, 'note.txt'), 'second', 'utf8')

    const result = await fail(service, 'write_file', { path: 'note.txt', content: 'third' })
    expect(result.error?.message).toContain('changed since it was read')
    expect(result.error?.message).toContain('sha256')
    expect(await readFile(join(dir, 'note.txt'), 'utf8')).toBe('second')
  })

  it('warns instead of refusing in warn mode, and still writes', async () => {
    const dir = await tempDir('tnega-fs-guard-warn-stale-')
    const service = await mount({ cwd: dir })
    await writeFile(join(dir, 'note.txt'), 'first', 'utf8')
    await ok(service, 'read_file', { path: 'note.txt' })
    await writeFile(join(dir, 'note.txt'), 'second', 'utf8')

    const written = await ok(service, 'write_file', { path: 'note.txt', content: 'third' })
    expect(String(written.warning)).toContain('changed since it was read')
    expect(await readFile(join(dir, 'note.txt'), 'utf8')).toBe('third')
  })

  it('tracks observations per agent', async () => {
    const dir = await tempDir('tnega-fs-guard-agent-')
    const service = await mount({ cwd: dir, fsGuard: 'enforce' })
    await writeFile(join(dir, 'note.txt'), 'shared', 'utf8')
    await ok(service, 'read_file', { path: 'note.txt' }, 'agent-a')

    const other = await fail(service, 'write_file', { path: 'note.txt', content: 'x' }, 'agent-b')
    expect(other.error?.message).toContain('has not been read')
    await ok(service, 'write_file', { path: 'note.txt', content: 'edited' }, 'agent-a')
  })

  it('creates new files without a prior read', async () => {
    const dir = await tempDir('tnega-fs-guard-create-')
    const service = await mount({ cwd: dir, fsGuard: 'enforce' })

    const written = await ok(service, 'write_file', { path: 'new/deep.txt', content: 'fresh' })
    expect(written.warning).toBeUndefined()
    expect(await readFile(join(dir, 'new', 'deep.txt'), 'utf8')).toBe('fresh')
  })
})
