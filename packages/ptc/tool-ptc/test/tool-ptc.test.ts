import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PtcRuntimeService, type PtcRequest, type PtcResult } from '@tnega/ptc-runtime'
import { SessionLog } from '@tnega/session'
import { tools, type ToolRequest, type ToolsService } from '@tnega/tools'
import { toolPtc } from '../src/index.js'

class FakeRuntime extends PtcRuntimeService {
  request: PtcRequest | undefined
  constructor(ctx: Context, private readonly run: (request: PtcRequest) => Promise<PtcResult>) { super(ctx) }
  override execute(request: PtcRequest): Promise<PtcResult> { this.request = request; return this.run(request) }
}
function registry(ctx: Context): ToolsService { return ctx.get('tools') }
const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

async function setup(run: (request: PtcRequest) => Promise<PtcResult>, mode: 'both' | 'ptc' = 'both') {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(tools)
  const runtime = new FakeRuntime(ctx, run)
  await ctx.plugin(toolPtc, { mode })
  return { ctx, runtime }
}

describe('run_code consumer', () => {
  it('records child intent and result as audit metadata, not orphan model results', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tnega-ptc-'))
    const session = new SessionLog(join(directory, 'session.jsonl'))
    const ctx = new Context()
    contexts.push(ctx)
    try {
      await ctx.plugin(tools)
      new FakeRuntime(ctx, async request => ({
        ok: true, value: await request.tools[0]?.execute({}, new AbortController().signal), output: [],
      }))
      registry(ctx).register({ schema: { name: 'echo', description: 'Echo' }, execute: async () => {
        expect((await session.read()).at(-1)).toMatchObject({ type: 'meta', payload: { kind: 'ptc/dispatch-start' } })
        return 'done'
      } })
      await ctx.plugin(toolPtc, { resolveSession: () => session })
      expect((await registry(ctx).execute('run_code', { code: 'test' }, { callId: 'outer' })).ok).toBe(true)
      const events = await session.read()
      expect(events.every(event => event.type === 'meta')).toBe(true)
      expect(events.filter(event => event.type === 'meta')
        .filter(event => typeof event.payload.kind === 'string' && event.payload.kind.startsWith('ptc/'))
        .map(event => event.payload.kind))
        .toEqual(['ptc/dispatch-start', 'ptc/dispatch'])
      expect((await session.read()).at(-1)).toMatchObject({ payload: { kind: 'ptc/dispatch', parentCallId: 'outer', ok: true } })
      expect(await session.deriveMessages()).toEqual([])
    } finally {
      await session.flush()
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('uses the existing permission pipeline and preserves child identities', async () => {
    let request: ToolRequest | undefined
    const { ctx } = await setup(async runtime => {
      const binding = runtime.tools.find(tool => tool.name === 'danger')
      expect(binding).toBeDefined()
      await expect(binding?.execute({}, new AbortController().signal)).rejects.toThrow('denied')
      return { ok: true, output: [] }
    })
    let executed = false
    registry(ctx).register({ schema: { name: 'danger', description: 'Danger' }, execute: () => { executed = true } })
    registry(ctx).guard(value => {
      if (value.name !== 'danger') return undefined
      request = value
      return 'denied'
    })
    expect((await registry(ctx).execute('run_code', { code: 'test' }, { callId: 'outer', agentId: 'a' })).ok).toBe(true)
    expect(executed).toBe(false)
    expect(request?.options.agentId).toBe('a')
    expect(request?.options.callId).toMatch(/^outer\/ptc\//)
  })

  it('serializes child dispatches and excludes recursive entry', async () => {
    const order: string[] = []
    const { ctx } = await setup(async runtime => {
      expect(runtime.tools.some(tool => tool.name === 'run_code')).toBe(false)
      const binding = runtime.tools.find(tool => tool.name === 'work')
      await Promise.all([binding?.execute('one', new AbortController().signal), binding?.execute('two', new AbortController().signal)])
      return { ok: true, output: [] }
    })
    registry(ctx).register({ schema: { name: 'work', description: 'Work' }, execute: async input => {
      order.push(`start:${input}`)
      await new Promise(resolve => setTimeout(resolve, 5))
      order.push(`end:${input}`)
    } })
    await registry(ctx).execute('run_code', { code: 'test' })
    expect(order).toEqual(['start:one', 'end:one', 'start:two', 'end:two'])
  })

  it('enforces PTC-only mode for direct dispatch without blocking children', async () => {
    const { ctx } = await setup(async request => ({
      ok: true, value: await request.tools[0]?.execute({}, new AbortController().signal), output: [],
    }), 'ptc')
    registry(ctx).register({ schema: { name: 'echo', description: 'Echo' }, execute: () => 42 })
    expect((await registry(ctx).execute('echo', {})).ok).toBe(false)
    expect(await registry(ctx).execute('run_code', { code: 'test' })).toMatchObject({ ok: true, output: { value: 42 } })
  })

  it('propagates a child tool conclusion to the outer result', async () => {
    const { ctx } = await setup(async request => {
      await request.tools[0]?.execute({}, new AbortController().signal)
      return { ok: true, output: [] }
    })
    registry(ctx).register({ schema: { name: 'finish', description: 'Finish' }, execute: (_input, options) => { options.concludesTurn = true } })
    expect(await registry(ctx).execute('run_code', { code: 'test' })).toMatchObject({ ok: true, concludesTurn: true })
  })

  it('surfaces script failures as a failed outer tool and does not retry child effects', async () => {
    let effects = 0
    const { ctx } = await setup(async request => {
      await request.tools[0]?.execute({}, new AbortController().signal)
      return { ok: false, error: 'script failed', output: ['completed one operation'] }
    })
    registry(ctx).register({ schema: { name: 'work', description: 'Work' }, execute: () => ++effects })
    expect(await registry(ctx).execute('run_code', { code: 'test' })).toMatchObject({
      ok: false, error: { name: 'PtcExecutionError', message: expect.stringContaining('completed one operation') },
    })
    expect(effects).toBe(1)
  })
})
