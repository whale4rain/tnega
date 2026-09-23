import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { SpillError, type SpillStore } from '@tnega/spill'
import { LocalSpillStore, spillLocal } from '../src/index.js'

const dirs: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function mount(cwd: string): Promise<SpillStore> {
  const root = new Context()
  await root.plugin(spillLocal, { cwd })
  return (root as unknown as { spillStore: SpillStore }).spillStore
}

describe('local spill backend', () => {
  it('writes the full text and returns a workspace-relative locator', async () => {
    const cwd = await tempDir('tnega-spill-local-')
    const store = await mount(cwd)
    const content = 'x'.repeat(5_000)

    const ref = await store.saveText({
      source: { kind: 'tool', toolName: 'shell', callId: 'call_1' },
      suggestedName: 'shell.txt',
      content,
    })

    expect(ref.bytes).toBe(5_000)
    // A relative locator is directly usable by the sandboxed read_file tool.
    expect(ref.locator).toBe('.tnega/spill/shell-call_1-shell.txt')
    expect(ref.retrievalHint).toContain('read_file')
    expect(await readFile(join(cwd, ref.locator), 'utf8')).toBe(content)
  })

  it('keeps each call of the same tool in its own artifact', async () => {
    const cwd = await tempDir('tnega-spill-unique-')
    const store = await mount(cwd)

    const first = await store.saveText({
      source: { kind: 'tool', toolName: 'shell', callId: 'call_1' },
      suggestedName: 'shell.txt',
      content: 'first',
    })
    const second = await store.saveText({
      source: { kind: 'tool', toolName: 'shell', callId: 'call_2' },
      suggestedName: 'shell.txt',
      content: 'second',
    })

    expect(second.locator).not.toBe(first.locator)
    expect(await readFile(join(cwd, first.locator), 'utf8')).toBe('first')
    expect(await readFile(join(cwd, second.locator), 'utf8')).toBe('second')
  })

  it('treats the suggested name as a hint, never as a path', async () => {
    const cwd = await tempDir('tnega-spill-escape-')
    const store = await mount(cwd)

    const ref = await store.saveText({
      source: { kind: 'tool', toolName: 'shell', callId: 'call_1' },
      suggestedName: '../../../../etc/passwd',
      content: 'not a password file',
    })

    expect(ref.locator).toBe('.tnega/spill/shell-call_1-passwd')
  })

  it('groups artifacts by owning session when one is given', async () => {
    const cwd = await tempDir('tnega-spill-session-')
    const store = await mount(cwd)

    const ref = await store.saveText({
      source: { kind: 'tool', toolName: 'shell', callId: 'call_1' },
      suggestedName: 'shell.txt',
      content: 'body',
      owner: { sessionId: 'session-a' },
    })

    expect(ref.locator).toBe('.tnega/spill/session-a/shell-call_1-shell.txt')
  })

  it('reports a real storage failure instead of degrading silently', async () => {
    const cwd = await tempDir('tnega-spill-fail-')
    // A file where the store needs a directory: mkdir cannot succeed.
    await writeFile(join(cwd, '.tnega'), 'not a directory', 'utf8')
    const store = await mount(cwd)

    await expect(store.saveText({
      source: { kind: 'tool', toolName: 'shell', callId: 'call_1' },
      suggestedName: 'shell.txt',
      content: 'body',
    })).rejects.toBeInstanceOf(SpillError)
  })

  it('exposes the same contract through the plugin and the class', async () => {
    const cwd = await tempDir('tnega-spill-config-')
    const root = new Context()
    const store = new LocalSpillStore(root, { cwd })
    expect(typeof store.saveText).toBe('function')
  })
})
