import { describe, expect, it } from 'vitest'
import type { ToolRequest } from '@tnega/tools'

import { ApprovalBroker, permissionGuard } from '../src/permissions.js'

function request(name: string, input: unknown): ToolRequest {
  return {
    name,
    input,
    tool: { schema: { name, description: '' }, execute: () => undefined },
    options: {},
    startedAt: 0,
  }
}

describe('permissionGuard', () => {
  it('allows job controls while child execution retains its own permission check', async () => {
    const guard = permissionGuard('read-only', 'session', new ApprovalBroker(), { workspace: process.cwd() })
    for (const name of ['job_start', 'job_list', 'job_output', 'job_kill']) {
      expect(await guard(request(name, {}))).toBeUndefined()
    }
    expect(await guard(request('shell', { command: 'echo hello' }))).toMatch(/approval/)
  })
  it('uses automatic review for an otherwise gated action and still preserves narrower child permissions', async () => {
    let reviews = 0
    const guard = permissionGuard('workspace-write', 'session', new ApprovalBroker(), {
      workspace: process.cwd(),
      agentMode: () => 'read-only',
      review: async () => { reviews += 1; return { decision: 'allow', risk: 'low', reason: 'Tests requested' } },
    })
    const call = request('shell', { command: 'pnpm test' })
    expect(await guard(call)).toBeUndefined()
    expect(call.options.approvedElevation).toBe(true)
    expect(reviews).toBe(1)
    const child = request('shell', { command: 'pnpm test' })
    child.options.agentId = 'child'
    expect(await guard(child)).toMatch(/approval/)
    expect(reviews).toBe(1)
  })

  it('never elevates a cancelled model-reviewed call', async () => {
    const controller = new AbortController()
    const guard = permissionGuard('workspace-write', 'session', new ApprovalBroker(), {
      workspace: process.cwd(),
      review: async () => { controller.abort(); return { decision: 'allow', risk: 'low', reason: 'ok' } },
    })
    const call = request('shell', { command: 'pnpm test' })
    call.options.signal = controller.signal
    expect(await guard(call)).toMatch(/cancel/i)
    expect(call.options.approvedElevation).toBeUndefined()
  })

  it('reads the current Session permission for each tool call', async () => {
    let mode: 'read-only' | 'workspace-write' | 'bypass' = 'read-only'
    const guard = permissionGuard(
      () => mode,
      'session',
      new ApprovalBroker(),
      { workspace: process.cwd() },
    )

    expect(await guard(request('write_file', { path: 'notes.txt', content: 'x' }))).toMatch(/approval/)
    mode = 'workspace-write'
    expect(await guard(request('write_file', { path: 'notes.txt', content: 'x' }))).toBeUndefined()
  })

  it('treats office reads as read-only and office writes like write_file', async () => {
    let mode: 'read-only' | 'workspace-write' = 'read-only'
    const guard = permissionGuard(() => mode, 'session', new ApprovalBroker(), { workspace: process.cwd() })

    expect(await guard(request('office_inspect', { path: 'report.xlsx' }))).toBeUndefined()
    expect(await guard(request('office_read', { path: 'report.xlsx' }))).toBeUndefined()
    expect(await guard(request('office_create', { path: 'report.xlsx', spec: {} }))).toMatch(/approval/)
    expect(await guard(request('office_edit', { path: 'report.xlsx', ops: [] }))).toMatch(/approval/)
    mode = 'workspace-write'
    expect(await guard(request('office_create', { path: 'report.xlsx', spec: {} }))).toBeUndefined()
    expect(await guard(request('office_edit', { path: 'report.xlsx', ops: [] }))).toBeUndefined()
  })
})

describe('browser and process permissions', () => {
  const guardAt = (mode: 'read-only' | 'workspace-write' | 'bypass', url: string | undefined) => permissionGuard(
    mode, 'session', new ApprovalBroker(), { workspace: process.cwd(), browserUrl: () => url },
  )

  it('lets the agent look at and move around any page', async () => {
    const guard = guardAt('read-only', 'https://example.com/')
    for (const name of ['browser_snapshot', 'browser_take_screenshot', 'browser_console_messages', 'browser_navigate', 'browser_reload', 'browser_resize', 'browser_tabs']) {
      expect(await guard(request(name, { url: 'https://example.com' }))).toBeUndefined()
    }
  })

  it('allows interacting with a local dev page in workspace-write but asks elsewhere', async () => {
    expect(await guardAt('workspace-write', 'http://localhost:5173/login')(request('browser_click', { ref: 'e3' }))).toBeUndefined()
    expect(await guardAt('workspace-write', 'http://127.0.0.1:3000')(request('browser_type', { ref: 'e3', text: 'x' }))).toBeUndefined()
    expect(await guardAt('workspace-write', 'https://shop.example.com/cart')(request('browser_click', { ref: 'e3' }))).toMatch(/approval/)
    expect(await guardAt('read-only', 'http://localhost:5173')(request('browser_evaluate', { function: '1' }))).toMatch(/approval/)
    expect(await guardAt('bypass', 'https://shop.example.com')(request('browser_click', { ref: 'e3' }))).toBeUndefined()
  })

  it('gates starting a background process like shell but not reading or stopping it', async () => {
    const guard = guardAt('workspace-write', undefined)
    expect(await guard(request('process_start', { command: 'npm run dev' }))).toMatch(/approval/)
    expect(await guard(request('process_output', { id: 'p1' }))).toBeUndefined()
    expect(await guard(request('process_stop', { id: 'p1' }))).toBeUndefined()
  })
})

it('gates fixed-home skill writes, including narrower child permissions', async () => {
  const approvals = new ApprovalBroker()
  const readonly = permissionGuard('read-only', 'session', approvals, { workspace: process.cwd() })
  const writable = permissionGuard('workspace-write', 'session', approvals, { workspace: process.cwd(), agentMode: () => 'read-only' })
  for (const name of ['skill_create', 'skill_install']) {
    expect(await readonly(request(name, {}))).toMatch(/approval/)
    expect(await writable(request(name, {}))).toBeUndefined()
    const child = request(name, {})
    child.options.agentId = 'child'
    expect(await writable(child)).toMatch(/approval/)
  }
})
