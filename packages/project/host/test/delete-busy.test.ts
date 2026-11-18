import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { LLMAdapter } from '@tnega/agent'
import { ApprovalBroker } from '@tnega/approval-host'
import { projectSessionRoot, workspaceProjectStateRoot } from '@tnega/home'
import { ProjectHost } from '../src/index.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

it('deleting a project while its coordinator answers leaves nothing behind', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'tnega-delete-busy-'))
  cleanups.push(() => rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  cleanups.push(() => rm(workspaceProjectStateRoot(workspace), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  let release!: () => void
  const answering = new Promise<void>(resolve => { release = resolve })
  let asked!: () => void
  const started = new Promise<void>(resolve => { asked = resolve })
  const llm: LLMAdapter = {
    complete: async () => {
      asked()
      await answering
      return { finishReason: 'stop', content: 'Late reply.' }
    },
  }
  const host = new ProjectHost({ workspace, llm, builtinTools: false, permission: 'read-only', approvals: new ApprovalBroker() })
  cleanups.push(() => host.dispose())
  const record = await host.create({ name: 'Busy' })
  await host.sendUserMessage(record.id, 'hello')
  await started
  const deleting = host.delete(record.id)
  release()
  await deleting
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(await host.get(record.id)).toBeUndefined()
  expect(existsSync(join(workspaceProjectStateRoot(workspace), 'projects', record.id))).toBe(false)
  expect(existsSync(projectSessionRoot(workspace, record.id))).toBe(false)
  expect(existsSync(join(workspace, '.tnega', 'projects', record.id))).toBe(false)
  await expect(host.mount(record.id)).rejects.toThrow(/not found/)
})

it('a request that arrives while a project is being deleted does not mount it again', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'tnega-delete-race-'))
  cleanups.push(() => rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  cleanups.push(() => rm(workspaceProjectStateRoot(workspace), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  const llm: LLMAdapter = { complete: async () => ({ finishReason: 'stop', content: 'ok' }) }
  const host = new ProjectHost({ workspace, llm, builtinTools: false, permission: 'read-only', approvals: new ApprovalBroker() })
  cleanups.push(() => host.dispose())
  const record = await host.create({ name: 'Racing' })
  await host.mount(record.id)
  const deleting = host.delete(record.id)
  const late = host.snapshot(record.id).then(() => 'mounted', () => 'refused')
  await deleting
  expect(await late).toBe('refused')
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(existsSync(join(workspaceProjectStateRoot(workspace), 'projects', record.id))).toBe(false)
  expect(existsSync(join(workspace, '.tnega', 'projects', record.id))).toBe(false)
})
