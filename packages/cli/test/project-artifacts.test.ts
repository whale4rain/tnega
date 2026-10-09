import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ProjectHost } from '../src/project-host.js'
import { ApprovalBroker } from '../src/permissions.js'
import { workspaceProjectStateRoot } from '../src/state-storage.js'
import { artifactThread, sendArtifactMessage } from '../src/project-artifacts.js'

const hosts: ProjectHost[] = []
const roots: string[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })))
})

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'tnega-artifact-chat-'))
  roots.push(workspace, workspaceProjectStateRoot(workspace))
  let calls = 0
  const host = new ProjectHost({ workspace, builtinTools: false, permission: 'read-only', approvals: new ApprovalBroker(),
    llm: { complete: async () => { calls++; return { finishReason: 'stop', content: 'Noted' } } } })
  hosts.push(host)
  const project = await host.create({ name: 'Artifact editing' })
  const scope = await host.mount(project.id)
  await host.stop(project.id)
  const thread = await scope.threads.spawn({ parentId: project.coordinatorId, goal: 'Write two documents' })
  const ref = await scope.artifacts.put({ content: 'First paragraph' })
  const artifact = await scope.blackboard.commit({ kind: 'artifact', id: ref.hash, expectedVersion: null,
    author: thread.id, data: { ...ref, title: 'Document', threadId: thread.id } })
  return { host, project, scope, thread, artifact, calls: () => calls }
}

it('opens the generating thread without creating or waking another agent', async () => {
  const f = await fixture()
  const before = await f.scope.threads.list()
  const opened = await artifactThread(f.host, f.project.id, f.artifact.id)
  expect(opened.thread.id).toBe(f.thread.id)
  expect(await f.scope.threads.list()).toHaveLength(before.length)
  expect(f.calls()).toBe(0)
})

it('sends a selected historical revision to its generator and rejects unrelated hashes', async () => {
  const f = await fixture()
  const revised = await f.scope.artifacts.put({ content: 'Second paragraph' })
  await f.scope.blackboard.commit({ kind: 'artifact', id: f.artifact.id, expectedVersion: 1,
    author: f.thread.id, data: { ...revised, title: 'Document', threadId: f.thread.id } })
  const envelope = await sendArtifactMessage(f.host, f.project.id, f.artifact.id, {
    text: 'Make this clearer', hash: f.artifact.id, quote: 'First paragraph',
  })
  expect(envelope.recipients).toEqual([{ kind: 'agent', id: f.thread.id }])
  expect(envelope.text).toContain('Make this clearer')
  expect(envelope.text).toContain('First paragraph')
  expect(envelope.text).toContain('older revision')
  expect(envelope.text).toContain(f.artifact.id)
  const before = (await f.scope.box.timeline()).length
  await expect(sendArtifactMessage(f.host, f.project.id, f.artifact.id, { text: 'Change', hash: '0'.repeat(64) })).rejects.toThrow('revision')
  expect(await f.scope.box.timeline()).toHaveLength(before)
})
