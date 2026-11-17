import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { LLMAdapter } from '@tnega/agent'
import { ApprovalBroker } from '@tnega/approval-host'
import { workspaceProjectStateRoot } from '@tnega/home'
import { ProjectHost } from '../src/index.js'

const QUIET = { projectMemory: { enabled: false } }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function folder(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), 'tnega-idle-unmount-'))
  cleanups.push(() => rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  cleanups.push(() => rm(workspaceProjectStateRoot(workspace), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return workspace
}

it('unmounts a project nobody uses and mounts it again on the next request', async () => {
  const workspace = await folder()
  const llm: LLMAdapter = { complete: async () => ({ finishReason: 'stop', content: 'Noted.' }) }
  const host = new ProjectHost({ workspace, llm, systemConfig: QUIET, builtinTools: false, permission: 'read-only', approvals: new ApprovalBroker() })
  cleanups.push(() => host.dispose())
  const record = await host.create({ name: 'Idle' })
  await host.sendUserMessage(record.id, 'remember the milk')
  const first = await host.mount(record.id)
  await expect.poll(async () => (await host.snapshot(record.id)).messages.some(envelope => envelope.text === 'Noted.'), { timeout: 10_000 }).toBe(true)
  await expect.poll(() => first.registry.list().every(agent => agent.status !== 'running'), { timeout: 10_000 }).toBe(true)

  // Used just now: kept.
  expect(await host.unmountIdle(60_000)).toEqual([])
  // A window has it open: kept however long it has been.
  const unwatch = await host.watch(record.id, { send: () => undefined })
  expect(await host.unmountIdle(60_000, Date.now() + 120_000)).toEqual([])
  unwatch()
  // Once the loop has finished delivering and publishing, nothing holds it.
  await expect.poll(() => host.unmountIdle(60_000, Date.now() + 120_000), { timeout: 10_000 }).toEqual([record.id])

  const again = await host.mount(record.id)
  expect(again).not.toBe(first)
  const snapshot = await host.snapshot(record.id)
  expect(snapshot.messages.map(envelope => envelope.text)).toEqual(['remember the milk', 'Noted.'])
})

it('keeps a project mounted while an Agent runs', async () => {
  const workspace = await folder()
  let release!: () => void
  const answering = new Promise<void>(resolve => { release = resolve })
  let asked!: () => void
  const started = new Promise<void>(resolve => { asked = resolve })
  const llm: LLMAdapter = {
    complete: async () => {
      asked()
      await answering
      return { finishReason: 'stop', content: 'Done.' }
    },
  }
  const host = new ProjectHost({ workspace, llm, systemConfig: QUIET, builtinTools: false, permission: 'read-only', approvals: new ApprovalBroker() })
  cleanups.push(async () => { release(); await host.dispose() })
  const record = await host.create({ name: 'Busy' })
  await host.sendUserMessage(record.id, 'work')
  await started
  expect(await host.unmountIdle(1, Date.now() + 120_000)).toEqual([])
  release()
})
