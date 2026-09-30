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
