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

  it('requires approval to elevate a child unless the Project bypasses permissions', async () => {
    let mode: 'read-only' | 'workspace-write' | 'bypass' = 'workspace-write'
    const approvals = new ApprovalBroker()
    const detach = approvals.attach('project', event => {
      approvals.decide(String(event.id), 'project', true)
    })
    const guard = permissionGuard(
      () => mode,
      'project',
      approvals,
      { workspace: process.cwd() },
    )
    const elevation = request('approve_thread_permission', {
      thread_id: 'child', permission: 'bypass',
    })

    try {
      expect(await guard(elevation)).toBeUndefined()
      expect(elevation.options.approvedElevation).toBe(true)
      mode = 'bypass'
      expect(await guard(elevation)).toBeUndefined()
    } finally {
      detach()
    }
  })
})
