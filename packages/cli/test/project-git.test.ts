import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { blackboardLocal } from '@tnega/blackboard-local'
import type { BlackboardService } from '@tnega/blackboard'
import { Context } from '@tnega/core'
import { gitOutcome, remoteWebUrl, trackGitOutcomes } from '../src/project-git.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const NEW_BRANCH = `remote:
remote: Create a pull request for 'feature/cards' on GitHub by visiting:
remote:      https://github.com/whale4rain/tnega/pull/new/feature/cards
remote:
To https://github.com/whale4rain/tnega.git
 * [new branch]      feature/cards -> feature/cards
branch 'feature/cards' set up to track 'origin/feature/cards'.
`

it('reads a push to a new branch, with the page that opens its pull request', () => {
  expect(gitOutcome('git push -u origin feature/cards', { exitCode: 0, stdout: '', stderr: NEW_BRANCH })).toEqual({
    kind: 'push', status: 'pushed', title: 'Pushed feature/cards', branch: 'feature/cards', repo: 'whale4rain/tnega',
    url: 'https://github.com/whale4rain/tnega/pull/new/feature/cards',
  })
})

it('reads an update, an up-to-date push and a rejection', () => {
  const update = 'To git@github.com:o/r.git\n   1a2b3c4..5d6e7f8  main -> main\n'
  expect(gitOutcome('cd app && git push', { exitCode: 0, stderr: update })).toMatchObject({
    status: 'pushed', branch: 'main', repo: 'o/r', url: 'https://github.com/o/r/tree/main',
  })
  expect(gitOutcome('git push', { exitCode: 0, stderr: 'Everything up-to-date\n' })).toMatchObject({ status: 'up-to-date', title: 'Push: already up to date' })
  const rejected = 'To https://github.com/o/r.git\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to \'https://github.com/o/r.git\'\n'
  expect(gitOutcome('git push origin main', { exitCode: 1, stderr: rejected })).toMatchObject({
    status: 'rejected', title: 'Push rejected: main', detail: "error: failed to push some refs to 'https://github.com/o/r.git'",
  })
})

it('reads an opened pull request and ignores commands that are neither', () => {
  expect(gitOutcome('gh pr create --fill', { exitCode: 0, stdout: 'https://github.com/o/r/pull/12\n' })).toEqual({
    kind: 'pull-request', status: 'opened', title: 'Pull request #12', url: 'https://github.com/o/r/pull/12', repo: 'o/r', number: 12,
  })
  expect(gitOutcome('gh pr create', { exitCode: 1, stderr: 'GraphQL: No commits between main and main\n' })).toMatchObject({ status: 'failed', detail: 'GraphQL: No commits between main and main' })
  expect(gitOutcome('git status', { exitCode: 0, stdout: 'To be pushed' })).toBeUndefined()
  expect(gitOutcome('echo "git pushes"', { exitCode: 0 })).toBeUndefined()
})

it('opens only remotes that have a web page', () => {
  expect(remoteWebUrl('https://user:token@gitlab.com/g/p.git')).toBe('https://gitlab.com/g/p')
  expect(remoteWebUrl('http://local_proxy@127.0.0.1:4567/git/o/r')).toBeUndefined()
  expect(remoteWebUrl('/srv/git/repo.git')).toBeUndefined()
})

it('records a thread\'s push as a Library resource it authored, and updates the same card on the next push', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tnega-project-git-'))
  roots.push(root)
  const ctx = new Context()
  await ctx.plugin(blackboardLocal, { root })
  const board = ctx.get('blackboard') as BlackboardService
  const agent = { id: 'thread-1', ctx: new Context() }
  trackGitOutcomes(ctx, board, [agent])
  const push = (id: string, stderr: string) => {
    agent.ctx.emit('session/event', { id: `e-${id}`, seq: 1, ts: 1, type: 'tool/call', payload: { id, name: 'shell', arguments: { command: 'git push -u origin feature/cards' } } })
    agent.ctx.emit('session/event', { id: `r-${id}`, seq: 2, ts: 2, type: 'tool/result', payload: { id, toolCallId: id, name: 'shell', ok: true, output: { exitCode: 0, stdout: '', stderr } } })
  }
  push('call-1', NEW_BRANCH)
  await expect.poll(async () => (await board.list('resource')).length).toBe(1)
  const [first] = await board.list('resource')
  expect(first).toMatchObject({ author: 'thread-1', data: { title: 'Pushed feature/cards', uri: 'https://github.com/whale4rain/tnega/pull/new/feature/cards', git: { kind: 'push', status: 'pushed' } } })
  push('call-2', 'To https://github.com/whale4rain/tnega.git\n   1a2b3c4..5d6e7f8  feature/cards -> feature/cards\n')
  await expect.poll(async () => (await board.list('resource'))[0]?.version).toBe(2)
  expect(await board.list('resource')).toHaveLength(1)
  await ctx.fiber.dispose()
  await agent.ctx.fiber.dispose()
})
