import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createTaskWorkspace, runWorkspaceCommand } from '../src/workspace.js'
import type { Task } from '../src/types.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('task workspace', () => {
  it('copies fixture root and explicit files', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'tnega-fixture-'))
    dirs.push(fixtureRoot)
    await writeFile(join(fixtureRoot, 'math.py'), 'VALUE = 1\n', 'utf8')
    const task: Task = {
      id: 't',
      fixture: {
        root: fixtureRoot,
        files: [{ path: 'extra.txt', content: 'extra' }],
      },
    }
    const workspace = await createTaskWorkspace(task)
    dirs.push(workspace.dir)
    expect(await readFile(join(workspace.dir, 'math.py'), 'utf8')).toContain('VALUE = 1')
    expect(await readFile(join(workspace.dir, 'extra.txt'), 'utf8')).toBe('extra')
    await workspace.dispose()
  })

  it('runs a command and returns exit code', async () => {
    const workspace = await createTaskWorkspace({ id: 't' })
    dirs.push(workspace.dir)
    const result = await runWorkspaceCommand(workspace.dir, 'node -e "process.exit(3)"')
    expect(result.exitCode).toBe(3)
  })

  it('aborts on timeout', async () => {
    const workspace = await createTaskWorkspace({ id: 't' })
    dirs.push(workspace.dir)
    const result = await runWorkspaceCommand(
      workspace.dir,
      'node -e "setTimeout(() => {}, 5000)"',
      { timeoutMs: 50 },
    )
    expect(result.exitCode).toBe(124)
  })
})
