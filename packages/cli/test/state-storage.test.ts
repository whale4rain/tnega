import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test } from 'vitest'
import { projectSessionRoot, workspaceProjectStateRoot, workspaceSubagentRoot } from '../src/state-storage.js'

test('imports Project and subagent history into home and leaves workspace artifacts intact', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'tnega-state-migration-'))
  const write = async (path: string, content: string) => {
    const file = join(workspace, '.tnega', path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content)
    return file
  }
  try {
    await write('blackboard/events.jsonl', 'project identity')
    await write('projects/project/blackboard/events.jsonl', 'messages')
    await write('projects/project/agents/thread/session.jsonl', 'thread history')
    const artifact = await write('projects/project/artifacts/report.md', 'user report')
    await write('subagents/child/session.jsonl', 'child history')
    const state = workspaceProjectStateRoot(workspace)
    expect(state.startsWith(process.env.TNEGA_HOME!)).toBe(true)
    expect(await readFile(join(state, 'blackboard/events.jsonl'), 'utf8')).toBe('project identity')
    expect(await readFile(join(state, 'projects/project/blackboard/events.jsonl'), 'utf8')).toBe('messages')
    expect(await readFile(join(projectSessionRoot(workspace, 'project'), 'agents/thread/session.jsonl'), 'utf8')).toBe('thread history')
    expect(await readFile(join(workspaceSubagentRoot(workspace), 'child/session.jsonl'), 'utf8')).toBe('child history')
    expect(await readFile(artifact, 'utf8')).toBe('user report')
    // Import markers prevent a retained backup from replacing subsequently written history.
    await writeFile(join(state, 'projects/project/blackboard/events.jsonl'), 'updated messages')
    workspaceProjectStateRoot(workspace)
    expect(await readFile(join(state, 'projects/project/blackboard/events.jsonl'), 'utf8')).toBe('updated messages')
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
