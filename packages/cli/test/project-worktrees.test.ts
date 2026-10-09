import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ProjectWorktrees } from '../src/project-worktrees.js'
import type { ToolsService } from '@tnega/tools'
import { ProjectHost } from '../src/project-host.js'
import { ApprovalBroker } from '../src/permissions.js'
import { projectSessionRoot, workspaceProjectStateRoot } from '../src/state-storage.js'

const exec = promisify(execFile)
const roots: string[] = []
const hosts: ProjectHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5 })
})
async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'tnega-worktrees-'))
  roots.push(root)
  await exec('git', ['init', '-b', 'main', root])
  await exec('git', ['-C', root, 'config', 'user.name', 'Test'])
  await exec('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
  await writeFile(join(root, 'file.txt'), 'base')
  await exec('git', ['-C', root, 'add', 'file.txt'])
  await exec('git', ['-C', root, 'commit', '-m', 'initial'])
  return root
}

it('isolates concurrent writers, preserves original changes, and resumes the same branch', async () => {
  const root = await repository()
  await writeFile(join(root, 'file.txt'), 'user changes')
  const manager = new ProjectWorktrees(root, join(root, '.state'), 'project')
  const [a, b] = await Promise.all([manager.prepare('one'), manager.prepare('two')])
  expect(a?.cwd).not.toBe(b?.cwd)
  expect(a).toBeDefined()
  if (!a || !b) throw new Error('expected git workspaces')
  await writeFile(join(a.cwd, 'file.txt'), 'first')
  expect(await readFile(join(b.cwd, 'file.txt'), 'utf8')).toBe('base')
  expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('user changes')
  const resumed = await new ProjectWorktrees(root, join(root, '.state'), 'project').prepare('one', a)
  expect(resumed).toEqual(a)
  expect(await manager.completion(a)).toContain('deliver_thread')
})

it('keeps non-Git workspaces ordinary and blocks PR delivery with missing origin', async () => {
  const root = await repository()
  const plain = await mkdtemp(join(tmpdir(), 'tnega-plain-'))
  roots.push(plain)
  expect(await new ProjectWorktrees(plain, join(plain, '.state'), 'project').prepare('one')).toBeUndefined()
  const manager = new ProjectWorktrees(root, join(root, '.state'), 'project')
  const workspace = await manager.prepare('one')
  if (!workspace) throw new Error('expected git workspace')
  expect(await manager.completion(workspace)).toBeUndefined()
  await writeFile(join(workspace.cwd, 'new.txt'), 'change')
  await expect(manager.deliver(workspace, { title: 'Change', body: 'Verified' })).rejects.toThrow(/commit/i)
  await exec('git', ['-C', workspace.cwd, 'add', 'new.txt'])
  await exec('git', ['-C', workspace.cwd, 'commit', '-m', 'change'])
  await expect(manager.deliver(workspace, { title: 'Change', body: 'Verified' })).rejects.toThrow(/origin/i)
})

it('retains the Workspace boundary when it is a repository subdirectory', async () => {
  const root = await repository()
  await mkdir(join(root, 'package'))
  await writeFile(join(root, 'package', 'inside.txt'), 'inside')
  await exec('git', ['-C', root, 'add', 'package'])
  await exec('git', ['-C', root, 'commit', '-m', 'add package'])
  const manager = new ProjectWorktrees(join(root, 'package'), join(root, '.state'), 'project')
  const workspace = await manager.prepare('one')
  if (!workspace) throw new Error('expected workspace')
  expect(workspace.cwd.endsWith('package')).toBe(true)
  expect(await readFile(join(workspace.cwd, 'inside.txt'), 'utf8')).toBe('inside')
  expect(await manager.prepare('one', workspace)).toEqual(workspace)
})

it('retries an uncertain PR creation by reusing the existing PR and verifies the head', async () => {
  const root = await repository()
  await exec('git', ['-C', root, 'remote', 'add', 'origin', 'https://github.com/example/repo.git'])
  let opened = false
  let creates = 0
  const pushed: string[][] = []
  const manager = new ProjectWorktrees(root, join(root, '.state'), 'project', async (command, args, cwd) => {
    if (command === 'git' && args[0] === 'push') { pushed.push(args); return '' }
    if (command === 'git') return (await exec(command, args, { cwd })).stdout.trim()
    const pr = { url: 'https://github.com/example/repo/pull/7', number: 7, state: 'OPEN' }
    if (args[1] === 'list') return JSON.stringify(opened ? [pr] : [])
    if (args[1] === 'create') { opened = true; creates += 1; throw new Error('Connection interrupted after creation') }
    const headRefOid = (await exec('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    return JSON.stringify({ ...pr, headRefOid })
  })
  const workspace = await manager.prepare('one')
  if (!workspace) throw new Error('expected git workspace')
  await writeFile(join(workspace.cwd, 'file.txt'), 'changed')
  await exec('git', ['-C', workspace.cwd, 'commit', '-am', 'change'])
  await expect(manager.deliver(workspace, { title: 'Change', body: 'Checks passed' })).rejects.toThrow('Connection interrupted')
  const delivered = await manager.deliver(workspace, { title: 'Change', body: 'Checks passed' })
  expect(delivered.pullRequest?.url).toBe('https://github.com/example/repo/pull/7')
  expect(creates).toBe(1)
  expect(pushed.every(args => !args.includes('--force'))).toBe(true)
  expect(await manager.completion(delivered)).toBeUndefined()
  await writeFile(join(workspace.cwd, 'file.txt'), 'another change')
  expect(await manager.completion(delivered)).toContain('deliver_thread')
})

it('binds file, search, artifact and nested tools to each Thread and preserves shared facts', async () => {
  const workspace = await repository()
  roots.push(workspaceProjectStateRoot(workspace))
  const host = new ProjectHost({ workspace, permission: 'workspace-write', approvals: new ApprovalBroker(),
    llm: { async complete() { return { content: 'Ready', finishReason: 'stop' } } } })
  hosts.push(host)
  const record = await host.create({ name: 'Writers' })
  roots.push(projectSessionRoot(workspace, record.id))
  const project = await host.mount(record.id)
  const [a, b] = await Promise.all([
    project.threads.spawn({ parentId: record.coordinatorId, goal: 'First writer' }),
    project.threads.spawn({ parentId: record.coordinatorId, goal: 'Second writer', permission: 'read-only' }),
  ])
  const first = await project.threads.activate(a.id)
  const second = await project.threads.activate(b.id)
  const firstTools: ToolsService = first.ctx.get('tools')
  const secondTools: ToolsService = second.ctx.get('tools')
  const written = await firstTools.execute('write_file', { path: 'own.txt', content: 'first only' }, { agentId: a.id })
  expect(written.ok).toBe(true)
  expect(a.workspace?.cwd).not.toBe(b.workspace?.cwd)
  expect(a.workspace).toBeDefined()
  if (!a.workspace || !b.workspace) throw new Error('expected isolated workspace')
  expect(await readFile(join(a.workspace.cwd, 'own.txt'), 'utf8')).toBe('first only')
  await expect(readFile(join(b.workspace.cwd, 'own.txt'))).rejects.toThrow()
  const own = await firstTools.execute('read_file', { path: 'own.txt' }, { agentId: a.id })
  expect(JSON.stringify(own.output)).toContain('first only')
  const other = await secondTools.execute('read_file', { path: 'own.txt' }, { agentId: b.id })
  expect(other.ok).toBe(false)
  expect((await firstTools.execute('glob', { pattern: 'own.txt' }, { agentId: a.id })).output).toEqual(['own.txt'])
  expect((await secondTools.execute('glob', { pattern: 'own.txt' }, { agentId: b.id })).output).toEqual([])
  const denied = await secondTools.execute('write_file', { path: 'forbidden.txt', content: 'no' }, { agentId: b.id, signal: AbortSignal.timeout(50) })
  expect(denied.ok).toBe(false)
  const published = await firstTools.execute('publish_artifact', { title: 'Report', path: 'own.txt' }, { agentId: a.id })
  expect(published.ok).toBe(true)
  expect(await project.blackboard.list('artifact')).toHaveLength(1)
  expect((await project.threads.setState(a.id, 'done')).state).toBe('blocked')
  expect((await project.threads.get(a.id))?.workspace).toEqual(a.workspace)
  await first.followup({ text: 'Finish this work' })
  await first.whenIdle()
  await expect.poll(async () => (await project.box.timeline()).some(envelope => envelope.sender.kind === 'agent' && envelope.sender.id === a.id && envelope.kind === 'blocked')).toBe(true)
  await expect(readFile(join(workspace, 'own.txt'))).rejects.toThrow()
})

it('keeps CodeMode nested writes scoped and restores the same checkout after host restart', async () => {
  const workspace = await repository()
  roots.push(workspaceProjectStateRoot(workspace))
  const options = { workspace, systemConfig: { codeMode: true }, permission: 'workspace-write' as const,
    approvals: new ApprovalBroker(), llm: { async complete() { return { content: 'Ready', finishReason: 'stop' as const } } } }
  const host = new ProjectHost(options)
  hosts.push(host)
  const record = await host.create({ name: 'CodeMode writer' })
  roots.push(projectSessionRoot(workspace, record.id))
  const project = await host.mount(record.id)
  const thread = await project.threads.spawn({ parentId: record.coordinatorId, goal: 'Write in CodeMode' })
  const agent = await project.threads.activate(thread.id)
  const registry: ToolsService = agent.ctx.get('tools')
  const result = await registry.execute('run_code', { code: 'await tools.write_file({path:"nested.txt",content:"isolated"}); text(await tools.read_file({path:"nested.txt"}));' }, { agentId: thread.id })
  expect(result.ok).toBe(true)
  expect(JSON.stringify(result.output)).toContain('isolated')
  await expect(readFile(join(workspace, 'nested.txt'))).rejects.toThrow()
  await host.dispose()
  const reopened = new ProjectHost(options)
  hosts.push(reopened)
  const restored = await reopened.mount(record.id)
  const resumed = await restored.threads.activate(thread.id)
  expect((await restored.threads.get(thread.id))?.workspace).toEqual(thread.workspace)
  const scoped: ToolsService = resumed.ctx.get('tools')
  const read = await scoped.execute('run_code', { code: 'text(await tools.read_file({path:"nested.txt"}));' }, { agentId: thread.id })
  expect(read.ok).toBe(true)
  expect(JSON.stringify(read.output)).toContain('isolated')
})
