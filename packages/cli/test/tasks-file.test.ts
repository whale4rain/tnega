import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { loadTasksFile } from '../src/commands.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('tasks file coding fields', () => {
  it('parses fixture, check, trials, permissions and split', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tnega-tasks-'))
    dirs.push(dir)
    const file = join(dir, 'tasks.yml')
    await writeFile(file, [
      'tasks:',
      '  - id: py-fib',
      '    inputText: implement fib',
      '    fixture:',
      '      root: fixtures/py-math',
      '    check: python -m unittest discover',
      '    trials: 2',
      '    split: val',
      '    permissions:',
      '      shell:',
      '        enabled: true',
      '        allow: [python]',
      'candidates:',
      '  deepseek:',
      '    coding: true',
      '    model: deepseek-v4-flash',
      'defaultCandidate: deepseek',
    ].join('\n'), 'utf8')
    const parsed = loadTasksFile(file)
    expect(parsed.tasks[0]?.trials).toBe(2)
    expect(parsed.tasks[0]?.split).toBe('val')
    expect(parsed.tasks[0]?.permissions?.shell?.allow).toEqual(['python'])
    expect(parsed.tasks[0]?.fixture?.root).toBe(join(dir, 'fixtures', 'py-math'))
  })

  it('keeps explicit fixture files and teardown', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tnega-tasks-files-'))
    dirs.push(dir)
    const file = join(dir, 'tasks.yml')
    await writeFile(file, [
      'tasks:',
      '  - id: write-file',
      '    inputText: write answer.txt',
      '    fixture:',
      '      files:',
      '        - path: answer.txt',
      '          content: ok',
      '    setup: echo setup',
      '    check: test -f answer.txt',
      '    teardown: echo done',
      '    trials: 1',
      '    split: train',
    ].join('\n'), 'utf8')
    const parsed = loadTasksFile(file)
    expect(parsed.tasks[0]?.fixture?.files).toEqual([
      { path: 'answer.txt', content: 'ok' },
    ])
    expect(parsed.tasks[0]?.setup).toBe('echo setup')
    expect(parsed.tasks[0]?.teardown).toBe('echo done')
  })
})
