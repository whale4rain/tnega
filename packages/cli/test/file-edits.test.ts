import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { captureFileEditBaseline, editedFiles } from '../src/file-edits.js'
import { listChanges } from '../src/changes.js'
import type { SessionEvent } from '@tnega/session'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

it('keeps runtime files out of explicit write results even without a Git baseline', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'tnega-write-edits-'))
  dirs.push(workspace)
  const events: SessionEvent[] = ['.tnega/sessions/current.jsonl', '.tnega/MEMORY.md'].map((path, index) => ({
    id: `result-${index}`, seq: index + 1, ts: index + 1,
    type: 'tool/result',
    payload: { id: `call-${index}`, toolCallId: `call-${index}`, name: 'write_file', ok: true, output: { path } },
  }))
  expect(await editedFiles(workspace, undefined, events, 0)).toEqual([{ path: '.tnega/MEMORY.md' }])
})

it('excludes runtime persistence from turn edits and workbench changes while retaining project configuration', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'tnega-runtime-edits-'))
  dirs.push(repo)
  const workspace = join(repo, 'app')
  const runtime = ['.tnega/sessions/existing.jsonl', '.tnega/sessions/new.jsonl', '.tnega/run-v1.jsonl', '.tnega/spill/result.txt', '.tnega/projects/project/agents/thread/session.jsonl']
  const visible = ['src/index.ts', '.tnega/MEMORY.md', '.tnega/skills/custom/SKILL.md', '.tnega/config.json', '.tnega/projects/project/artifacts/readme.md']
  const write = async (path: string, text: string) => {
    await mkdir(dirname(join(workspace, path)), { recursive: true })
    await writeFile(join(workspace, path), text)
  }
  await write('src/index.ts', 'before\n')
  await write(runtime[0]!, 'before\n')
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'init'], { cwd: repo })
  // An existing dirty Session at turn start must also be excluded.
  await write(runtime[0]!, 'already dirty\n')
  const baseline = await captureFileEditBaseline(workspace)
  await Promise.all([...runtime, ...visible].map(path => write(path, 'after\n')))
  expect((await editedFiles(workspace, baseline, [], 0)).map(file => file.path)).toEqual([...visible].sort())
  expect((await listChanges(workspace)).files.map(file => file.path).sort()).toEqual([...visible].sort())
})
