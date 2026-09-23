import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@tnega/core'
import { SpillStore, type SaveTextSpill, type SpillRef } from '@tnega/spill'
import { tools, type ToolDefinition, type ToolResult, type ToolsService } from '@tnega/tools'
import {
  composeSpillNotice,
  DEFAULT_HEAD_BYTES,
  DEFAULT_TAIL_BYTES,
  formatSpillNotice,
  toolSpill,
  type ToolSpillConfig,
} from '../src/index.js'

const MAX_INLINE_BYTES = 4_000
const LOCATOR = '.tnega/spill/big-call_1-big.txt'

/**
 * A backend the consumer has never heard of.
 *
 * The policy under test must talk to `ctx.spillStore` and nothing else, so its
 * tests mount this instead of any real backend — if a change here made the
 * policy depend on a specific provider, these tests would stop compiling.
 */
class FakeStore extends SpillStore {
  readonly saved: SaveTextSpill[] = []
  fail = false

  constructor(ctx: Context) {
    super(ctx)
  }

  override async saveText(request: SaveTextSpill): Promise<SpillRef> {
    if (this.fail) throw new Error('no space left on device')
    this.saved.push(request)
    return {
      locator: LOCATOR,
      bytes: Buffer.byteLength(request.content, 'utf8'),
      retrievalHint: 'Read it with the read_file tool.',
    }
  }
}

interface Mounted {
  root: Context
  service: ToolsService
  store: FakeStore
}

const roots: Context[] = []

afterEach(() => {
  roots.splice(0)
})

function bigTool(body: string): ToolDefinition {
  return { schema: { name: 'big', description: 'returns a lot' }, execute: () => body }
}

async function mount(
  definition: ToolDefinition,
  config: ToolSpillConfig = {},
): Promise<Mounted> {
  const root = new Context()
  roots.push(root)
  await root.plugin(tools)
  const store = new FakeStore(root)
  await root.plugin(toolSpill, { maxInlineBytes: MAX_INLINE_BYTES, ...config })
  const service = (root as unknown as { tools: ToolsService }).tools
  service.register(definition)
  return { root, service, store }
}

function text(result: ToolResult): string {
  expect(result.ok).toBe(true)
  return String(result.output)
}

describe('tool output spill', () => {
  it('replaces an oversized result with a preview and a locator', async () => {
    const body = 'H'.repeat(9_000) + 'MIDDLE' + 'T'.repeat(9_000)
    const { service, store } = await mount(bigTool(body))
    const result = await service.execute('big', {}, { callId: 'call_1' })
    const rendered = text(result)

    // The whole replacement stays inside the budget the policy promised.
    expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(MAX_INLINE_BYTES)
    expect(rendered.startsWith('H')).toBe(true)
    expect(rendered).toContain('T'.repeat(200))
    expect(rendered).toContain('Omitted')
    expect(rendered).toContain(LOCATOR)
    expect(rendered).toContain('read_file')
    // The head and the tail were kept; their middle is exactly what is missing.
    expect(rendered).not.toContain('MIDDLE')

    // Nothing was lost: the store got the entire output, byte for byte.
    expect(store.saved).toHaveLength(1)
    expect(store.saved[0]!.content).toBe(body)
    expect(store.saved[0]!.source).toEqual({
      kind: 'tool',
      toolName: 'big',
      callId: 'call_1',
      label: 'output',
    })
  })

  it('leaves a result within the cap alone', async () => {
    const { service, store } = await mount(bigTool('short'))
    expect(text(await service.execute('big', {}))).toBe('short')
    expect(store.saved).toHaveLength(0)
  })

  it('skips tools that would read back their own spill', async () => {
    const { service, store } = await mount(
      { schema: { name: 'read_file', description: 'reads' }, execute: () => 'R'.repeat(9_000) },
    )
    expect(text(await service.execute('read_file', {}))).toBe('R'.repeat(9_000))
    expect(store.saved).toHaveLength(0)
  })

  it('honours a configured skip list beyond the default', async () => {
    const { service } = await mount(bigTool('B'.repeat(9_000)), { skip: ['big'] })
    expect(text(await service.execute('big', {}))).toBe('B'.repeat(9_000))
  })

  it('keeps the original result when the store fails', async () => {
    const { root, service, store } = await mount(bigTool('B'.repeat(9_000)))
    store.fail = true
    const warn = vi.spyOn(root.logger, 'warn').mockImplementation(() => {})

    const result = await service.execute('big', {})
    // A spill failure must not turn a successful call into a failed one, and
    // must not hide the content it failed to store.
    expect(text(result)).toBe('B'.repeat(9_000))
    expect(warn).toHaveBeenCalled()
  })

  it('cuts a preview on a UTF-8 boundary', async () => {
    const { service } = await mount(bigTool('记'.repeat(4_000)))
    const rendered = text(await service.execute('big', {}, { callId: 'call_1' }))

    expect(rendered).not.toContain('�')
    expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(MAX_INLINE_BYTES)
  })

  it('refuses a cap that is not a usable byte budget', async () => {
    const root = new Context()
    roots.push(root)
    await root.plugin(tools)
    new FakeStore(root)
    await expect(root.plugin(toolSpill, { maxInlineBytes: -1 })).rejects.toThrow(TypeError)
  })
})

describe('notice composition', () => {
  // Pins the producer's exact wording. The web bundle cannot import this
  // package, so `apps/web/src/toolOutput.test.ts` carries a copy of the same
  // string; changing the format here without changing it there makes both
  // readers silently stop recognising notices.
  it('writes the notice in the shape the web reader recognises', () => {
    expect(formatSpillNotice(14_129, {
      locator: '.tnega/spill/big-call_1-big.txt',
      bytes: 18_000,
      retrievalHint:
        'Read it with the read_file tool (raise maxBytes or use offset/limit '
        + 'for a specific window), or grep this path to search inside it.',
    })).toBe(
      '\n\n(Omitted 14129 bytes. Full formatted result stored at: '
      + '.tnega/spill/big-call_1-big.txt. Read it with the read_file tool '
      + '(raise maxBytes or use offset/limit for a specific window), '
      + 'or grep this path to search inside it.)',
    )
  })

  const ref: SpillRef = {
    locator: LOCATOR,
    bytes: 18_000,
    retrievalHint: 'Read it with the read_file tool.',
  }

  it('returns nothing when the cap cannot hold the notice', () => {
    expect(composeSpillNotice('x'.repeat(1_000), ref, {
      maxInlineBytes: 32,
      headBytes: DEFAULT_HEAD_BYTES,
      tailBytes: DEFAULT_TAIL_BYTES,
    })).toBeUndefined()
  })

  it('returns nothing for text that already fits', () => {
    expect(composeSpillNotice('tiny', ref, {
      maxInlineBytes: 1_000,
      headBytes: DEFAULT_HEAD_BYTES,
      tailBytes: DEFAULT_TAIL_BYTES,
    })).toBeUndefined()
  })

  it('names the exact number of omitted bytes', () => {
    const composed = composeSpillNotice('x'.repeat(10_000), ref, {
      maxInlineBytes: 1_000,
      headBytes: 400,
      tailBytes: 200,
    })!
    const omitted = Number(composed.match(/Omitted (\d+) bytes/)![1])
    const cut = composed.indexOf('\n\n(Omitted')
    const kept = Buffer.byteLength(composed.slice(0, cut), 'utf8')
    expect(omitted).toBe(10_000 - kept)
    expect(formatSpillNotice(omitted, ref)).toBe(composed.slice(cut))
  })
})
