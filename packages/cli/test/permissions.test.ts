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
})
