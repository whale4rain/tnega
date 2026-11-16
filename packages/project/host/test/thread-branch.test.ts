import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import type { LLMAdapter } from '@tnega/agent'
import { ApprovalBroker } from '@tnega/approval-host'
import { workspaceProjectStateRoot } from '@tnega/home'
import { ProjectHost, type ThreadMachines } from '../src/index.js'

const exec = promisify(execFile)
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const QUIET = { projectMemory: { enabled: false } }
const llm: LLMAdapter = { complete: async () => ({ finishReason: 'stop', content: 'ok' }) }

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', args, { cwd })).stdout.trim()
}

/**
 * A stand-in for a thread's box: its workspace is a real git checkout here,
 * git runs for real, and gh answers as GitHub would. Pushes are recorded.
 */
function boxes(checkout: string, pushed: string[]): ThreadMachines {
  return {
    async open() {
      return {
        machine: { link: { deviceId: 'box', protocolVersion: 2, capabilities: { fs: true, process: true, http: true, platform: 'linux' }, workspaces: [{ id: 'ws', path: checkout }], closed: false, call: () => Promise.reject(new Error('no daemon in this test')), onNotification: () => () => undefined, onClose: () => () => undefined, close: () => undefined }, isolated: true },
        cwd: checkout,
        close: () => undefined,
        run: async (command, args, cwd) => {
          if (command === 'git' && args[0] === 'push') {
            pushed.push(args.at(-1) ?? '')
            return ''
          }
          if (command === 'gh') {
            if (args[1] === 'list') return '[]'
            if (args[1] === 'create') return 'https://github.com/acme/app/pull/7'
            const head = await git(cwd, 'rev-parse', 'HEAD')
            return JSON.stringify({ url: 'https://github.com/acme/app/pull/7', number: 7, state: 'OPEN', headRefOid: head })
          }
          return (await exec(command, args, { cwd })).stdout.trim()
        },
      }
    },
    forget: async () => undefined,
  }
}

it('makes a thread\'s branch in its box\'s workspace and delivers it as a pull request card', async () => {
  const checkout = await mkdtemp(join(tmpdir(), 'tnega-thread-branch-'))
  cleanups.push(() => rm(checkout, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  cleanups.push(() => rm(workspaceProjectStateRoot(checkout), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  await git(checkout, 'init', '-q', '-b', 'main')
  await git(checkout, 'config', 'user.email', 'test@example.com')
  await git(checkout, 'config', 'user.name', 'Test')
  await writeFile(join(checkout, 'README.md'), 'app\n')
  await git(checkout, 'add', '.')
  await git(checkout, 'commit', '-q', '-m', 'first')
  await git(checkout, 'remote', 'add', 'origin', 'https://github.com/acme/app.git')
  const pushed: string[] = []
  // The host's own folder is elsewhere: the branch must come from the box, not from here.
  const hostFolder = await mkdtemp(join(tmpdir(), 'tnega-thread-host-'))
  cleanups.push(() => rm(hostFolder, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  cleanups.push(() => rm(workspaceProjectStateRoot(hostFolder), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  const projects = new ProjectHost({ workspace: hostFolder, llm, systemConfig: QUIET, permission: 'workspace-write', approvals: new ApprovalBroker(), threadMachines: boxes(checkout, pushed) })
  cleanups.push(() => projects.dispose())

  const record = await projects.create({ name: 'Ship it' })
  const project = await projects.mount(record.id)
  const child = await project.threads.spawn({ parentId: record.coordinatorId, goal: 'Add a file' })
  const agent = await project.threads.activate(child.id)
  const thread = await project.threads.get(child.id)
  const branch = `codex/thread-${record.id}-${child.id}`
  expect(thread?.workspace).toMatchObject({ cwd: join(checkout, '.tnega', 'worktrees', child.id), branch, baseBranch: 'main' })
  expect(await git(checkout, 'branch', '--list', branch)).toContain(branch)

  const cwd = thread?.workspace?.cwd ?? ''
  await writeFile(join(cwd, 'feature.txt'), 'new\n')
  await git(cwd, 'add', '.')
  await git(cwd, 'commit', '-q', '-m', 'feature')
  // The tool itself, past the approval guards (an agent's call would be reviewed first).
  const deliver = agent.ctx.get('tools').list().find(tool => tool.schema.name === 'deliver_thread')
  await deliver?.execute({ title: 'Add feature', body: 'Adds feature.txt.' }, { agentId: child.id, signal: new AbortController().signal })
  expect(pushed).toEqual([`HEAD:refs/heads/${branch}`])
  expect((await project.threads.get(child.id))?.workspace?.pullRequest).toMatchObject({ number: 7, url: 'https://github.com/acme/app/pull/7' })
  const cards = await project.blackboard.list('resource')
  expect(cards.map(card => card.data)).toContainEqual(expect.objectContaining({ title: 'Pull request #7' }))
  expect(JSON.stringify(cards.map(card => card.data))).toContain('https://github.com/acme/app/pull/7')
})
