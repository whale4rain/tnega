import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@tnega/tools'

import { createEvalToolPolicy } from '../src/policy.js'

function tool(name: string): ToolDefinition {
  return {
    schema: { name, description: name },
    execute: () => ({}),
  }
}

function request(name: string, input: unknown) {
  return {
    tool: tool(name),
    name,
    input,
    options: {},
    startedAt: 0,
  }
}

describe('eval tool policy', () => {
  const policy = createEvalToolPolicy({
    workspace: 'C:\\ws',
    permissions: {
      shell: { enabled: true, allow: ['pytest', 'python'], deny: ['rm'] },
      network: false,
    },
    maxOutputBytes: 8,
  })

  it('allows whitelisted tools', async () => {
    expect(await policy.authorizer?.(request('read_file', {}))).toBe(true)
  })

  it('denies tools outside the whitelist', async () => {
    expect(await policy.authorizer?.(request('echo', {}))).toBe(false)
  })

  it('denies shell when command is not allowed', async () => {
    expect(await policy.authorizer?.(request('shell', { command: 'rm -rf /' }))).toBe(false)
  })

  it('allows shell when command matches allow prefix', async () => {
    expect(await policy.authorizer?.(request('shell', { command: 'pytest -q' }))).toBe(true)
  })

  it('denies network by default', async () => {
    expect(await policy.authorizer?.(request('http_get', { url: 'https://x' }))).toBe(false)
  })

  it('truncates oversized output', async () => {
    const result = await policy.truncator?.(
      { ok: true, name: 'read_file', input: {}, output: 'abcdefghij', startedAt: 0, durationMs: 1 },
      request('read_file', {}),
    )
    expect(String(result?.output)).toBe('abcdefgh')
  })
})
