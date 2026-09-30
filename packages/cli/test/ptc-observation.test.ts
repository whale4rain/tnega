import { expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { tools, type ToolsService } from '@tnega/tools'
import { observePtc } from '../src/ptc-observation.js'
import { ApprovalBroker, permissionGuard } from '../src/permissions.js'

it('shows a nested call before review and reports its result without asking after auto allow', async () => {
  const ctx = new Context()
  const events: Record<string, unknown>[] = []
  try {
    await ctx.plugin(tools)
    const registry: ToolsService = ctx.get('tools')
    registry.register({ schema: { name: 'shell', description: 'Shell' }, execute: () => 'done' })
    let reviews = 0
    let humanRequests = 0
    const broker = new ApprovalBroker()
    const detach = broker.attach('session', () => { humanRequests++ })
    const releaseGuard = registry.guard(permissionGuard('workspace-write', 'session', broker, {
      workspace: process.cwd(), review: async () => {
        reviews++
        expect(events).toMatchObject([{ type: 'ptc/dispatch', payload: { kind: 'ptc/dispatch-start', name: 'shell' } }])
        return { decision: 'allow', risk: 'low', reason: 'Requested tests' }
      },
    }))
    const observer = await observePtc(ctx, 'session', event => events.push(event))
    const result = await registry.execute('shell', { command: 'test' }, { agentId: 'session', callId: 'child', ptcParentCallId: 'outer' })
    expect(result.ok).toBe(true)
    expect(reviews).toBe(1)
    expect(humanRequests).toBe(0)
    expect(events).toMatchObject([
      { payload: { kind: 'ptc/dispatch-start', parentCallId: 'outer', callId: 'child' } },
      { payload: { kind: 'ptc/dispatch', ok: true, result: { output: 'done' } } },
    ])
    await observer.dispose()
    await releaseGuard()
    await registry.execute('shell', {}, { agentId: 'session', callId: 'later', ptcParentCallId: 'outer' })
    expect(events).toHaveLength(2)
    detach()
  } finally { await ctx.fiber.dispose() }
})
