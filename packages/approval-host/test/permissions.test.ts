import { describe, expect, it, vi } from 'vitest'
import type { ToolRequest } from '@tnega/tools'

import { ApprovalBroker, permissionGuard } from '../src/index.js'

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
  it('remembers a person\'s allow for a tool\'s grant scope until the Session ends', async () => {
    const broker = new ApprovalBroker()
    const asked: Array<Record<string, unknown>> = []
    broker.attach('session', event => {
      asked.push(event)
      queueMicrotask(() => broker.decide(String(event.id), 'session', true))
    })
    const guard = permissionGuard('workspace-write', 'session', broker, { workspace: process.cwd() })
    const call = (app: string): ToolRequest => {
      const next = request('computer_click', { window_id: 1, x: 2, y: 3 })
      next.tool.grant = () => ({ scope: `computer:app:${app}`, label: `use ${app}` })
      return next
    }
    expect(await guard(call('Notepad'))).toBeUndefined()
    expect(await guard(call('Notepad'))).toBeUndefined()
    expect(asked).toHaveLength(1)
    expect(asked[0]?.grant).toEqual({ scope: 'computer:app:Notepad', label: 'use Notepad' })
    expect(await guard(call('Calculator'))).toBeUndefined()
    expect(asked).toHaveLength(2)
    // Another Session starts over.
    expect(broker.granted('other', 'computer:app:Notepad')).toBe(false)
  })

  it('does not remember a grant the person denied or an automatic reviewer allowed', async () => {
    const broker = new ApprovalBroker()
    let allow = false
    broker.attach('session', event => queueMicrotask(() => broker.decide(String(event.id), 'session', allow)))
    const reviewed = permissionGuard('workspace-write', 'session', broker, {
      workspace: process.cwd(),
      review: async () => ({ decision: 'allow', risk: 'low', reason: 'fine' }),
    })
    const call = (): ToolRequest => {
      const next = request('computer_click', {})
      next.tool.grant = () => ({ scope: 'computer:app:Notepad', label: 'use Notepad' })
      return next
    }
    expect(await reviewed(call())).toBeUndefined()
    expect(broker.granted('session', 'computer:app:Notepad')).toBe(false)
    const manual = permissionGuard('workspace-write', 'session', broker, { workspace: process.cwd() })
    expect(await manual(call())).toMatch(/approval/)
    expect(broker.granted('session', 'computer:app:Notepad')).toBe(false)
    allow = true
    expect(await manual(call())).toBeUndefined()
    expect(broker.granted('session', 'computer:app:Notepad')).toBe(true)
  })

  it('allows job controls while child execution retains its own permission check', async () => {
    const guard = permissionGuard('read-only', 'session', new ApprovalBroker(), { workspace: process.cwd() })
    for (const name of ['job_list', 'job_output', 'job_kill']) {
      expect(await guard(request(name, {}))).toBeUndefined()
    }
    expect(await guard(request('shell', { command: 'echo hello' }))).toMatch(/approval/)
  })
  it('keeps a narrower child\'s edits inside the workspace when the parent bypasses', async () => {
    const guard = permissionGuard('bypass', 'session', new ApprovalBroker(), { workspace: process.cwd(), agentMode: () => 'workspace-write' })
    const inside = request('edit_file', { path: 'notes.txt', edits: [] })
    inside.options.agentId = 'child'
    expect(await guard(inside)).toBeUndefined()
    const outside = request('edit_file', { path: '../elsewhere.txt', edits: [] })
    outside.options.agentId = 'child'
    expect(await guard(outside)).toMatch(/approval/)
  })
  it('lets the session tools read past sessions without asking, even in read-only mode', async () => {
    const guard = permissionGuard('read-only', 'session', new ApprovalBroker(), { workspace: process.cwd() })
    expect(await guard(request('search_sessions', { query: 'installer' }))).toBeUndefined()
    expect(await guard(request('search_session', { session: 'tnega://session/x', query: 'a' }))).toBeUndefined()
    expect(await guard(request('read_session', { session: 'x', workspace: '/elsewhere' }))).toBeUndefined()
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

  it('lets the reviewer decide for project threads and never asks a person', async () => {
    const broker = new ApprovalBroker()
    const asked: string[] = []
    broker.attach('project', event => asked.push(String(event.tool)))
    let decision: 'allow' | 'ask' | 'deny' = 'allow'
    const guard = permissionGuard('workspace-write', 'project', broker, {
      workspace: process.cwd(),
      agentMode: () => 'read-only',
      delegated: agentId => agentId === 'thread',
      review: async () => ({ decision, risk: 'low', reason: decision === 'allow' ? 'covered by the request' : 'outside the workspace' }),
    })
    const allowed = request('shell', { command: 'pnpm test' })
    allowed.options.agentId = 'thread'
    expect(await guard(allowed)).toBeUndefined()
    expect(allowed.options.approvedElevation).toBe(true)

    for (const next of ['ask', 'deny'] as const) {
      decision = next
      const blocked = request('shell', { command: 'rm -rf ../elsewhere' })
      blocked.options.agentId = 'thread'
      const message = await guard(blocked)
      expect(message).toMatch(/not approved: outside the workspace/)
      expect(message).toMatch(/ask your coordinator/)
      expect(blocked.options.approvedElevation).toBeUndefined()
    }
    expect(asked).toEqual([])
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

  it('gates a backgrounded command on the shell it is, and leaves collecting it free', async () => {
    const guard = guardAt('workspace-write', undefined)
    // runInBackground is a shell parameter: the command meets the shell gate once.
    expect(await guard(request('shell', { command: 'npm run dev', runInBackground: true }))).toMatch(/approval/)
    expect(await guard(request('job_output', { job_id: 'tool-1' }))).toBeUndefined()
    expect(await guard(request('job_kill', { job_id: 'tool-1' }))).toBeUndefined()
  })
})

it('gates fixed-home skill writes, including narrower child permissions', async () => {
  const approvals = new ApprovalBroker()
  const readonly = permissionGuard('read-only', 'session', approvals, { workspace: process.cwd() })
  const writable = permissionGuard('workspace-write', 'session', approvals, { workspace: process.cwd(), agentMode: () => 'read-only' })
  for (const action of ['create', 'install']) {
    expect(await readonly(request('skill', { action }))).toMatch(/approval/)
    expect(await writable(request('skill', { action }))).toBeUndefined()
    const child = request('skill', { action })
    child.options.agentId = 'child'
    expect(await writable(child)).toMatch(/approval/)
  }
  // Reading a skill is metadata work, never a write.
  expect(await readonly(request('skill', { action: 'list' }))).toBeUndefined()
  expect(await readonly(request('skill', { action: 'read', name: 'tdd' }))).toBeUndefined()
})

it('tells the model when nobody answered an approval in time, apart from a refusal', async () => {
  vi.useFakeTimers()
  try {
    const approvals = new ApprovalBroker()
    const events: Array<Record<string, unknown>> = []
    approvals.attach('session', event => { events.push(event) })
    const guard = permissionGuard('workspace-write', 'session', approvals, { workspace: process.cwd() })
    const unanswered = guard(request('shell', { command: 'npm test' }))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(await unanswered).toMatch(/^shell was not approved: nobody answered the approval request within 2 minutes/)
    const refused = guard({ ...request('shell', { command: 'npm test' }), options: { ptcParentCallId: 'outer' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(events.at(-1)).toMatchObject({ type: 'approval/request', tool: 'shell', via: 'run_code' })
    approvals.decide(String(events.at(-1)!.id), 'session', false)
    expect(await refused).toBe('shell requires human approval in workspace-write mode')
  } finally {
    vi.useRealTimers()
  }
})
