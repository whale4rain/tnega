import { describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import {
  DEFAULT_SEARCH_EXCLUDES,
  DEFAULT_SEARCH_MAX_RESULTS,
  DEFAULT_SEARCH_OUTPUT_MAX_BYTES,
  DEFAULT_SEARCH_TIMEOUT_MS,
  SearchError,
  SearchService,
  type FindFilesPreEvent,
  type FindFilesRequest,
  type FindFilesResult,
  type FindFilesResultEvent,
  type FindFilesSpec,
  type SearchErrorEvent,
  type SearchPostEvent,
  type SearchPreEvent,
  type SearchSpecBase,
  type SearchTextRequest,
  type SearchTextResult,
  type SearchTextResultEvent,
  type SearchTextSpec,
} from '../src/index.js'

function baseSpec(
  path: string | undefined,
  maxResults: number | undefined,
  signal: AbortSignal | undefined,
): SearchSpecBase {
  return {
    root: path ?? '.',
    maxResults: maxResults ?? DEFAULT_SEARCH_MAX_RESULTS,
    excludes: DEFAULT_SEARCH_EXCLUDES,
    respectGitignore: true,
    maxOutputBytes: DEFAULT_SEARCH_OUTPUT_MAX_BYTES,
    timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  }
}

/**
 * 只回答固定结果的 Provider。它不 import、也不提及任何事件名：事件面在
 * `SearchService` 的模板方法上，Provider 只实现机制，因此自动参与全部事件。
 */
class StubSearch extends SearchService {
  readonly specs: FindFilesSpec[] = []
  readonly textSpecs: SearchTextSpec[] = []
  files: FindFilesResult = { paths: [], truncated: false }
  matches: SearchTextResult = { matches: [], truncated: false }
  failure: Error | undefined

  override resolveFindFiles(request: FindFilesRequest): FindFilesSpec {
    return {
      ...baseSpec(request.path, request.maxResults, request.signal),
      pattern: request.pattern,
    }
  }

  override resolveSearchText(request: SearchTextRequest): SearchTextSpec {
    return {
      ...baseSpec(request.path, request.maxResults, request.signal),
      pattern: request.pattern,
      ...(request.glob !== undefined ? { glob: request.glob } : {}),
    }
  }

  protected override async runFindFiles(spec: FindFilesSpec): Promise<FindFilesResult> {
    this.specs.push(spec)
    if (this.failure) throw this.failure
    return this.files
  }

  protected override async runSearchText(spec: SearchTextSpec): Promise<SearchTextResult> {
    this.textSpecs.push(spec)
    if (this.failure) throw this.failure
    return this.matches
  }
}

interface Harness {
  root: Context
  service: SearchService
  stub: StubSearch
}

/** 直接构造 Provider：它在基类构造时把自己注册成 `ctx.search`。 */
function harness(): Harness {
  const root = new Context()
  const stub = new StubSearch(root)
  return { root, service: stub, stub }
}

describe('search/pre-search', () => {
  it('lets a listener rewrite the resolved spec before the provider runs', async () => {
    const { root, service, stub } = harness()
    const ops: string[] = []
    const before: number[] = []
    root.on('search/pre-search', (event: FindFilesPreEvent, next: () => unknown) => {
      ops.push(event.op)
      before.push(event.spec.maxResults)
      event.spec = { ...event.spec, maxResults: 1 }
      return next()
    })

    await service.findFiles(service.resolveFindFiles({ pattern: '**/*.ts' }))

    expect(ops).toEqual(['findFiles'])
    expect(before).toEqual([DEFAULT_SEARCH_MAX_RESULTS])
    expect(stub.specs[0]?.maxResults).toBe(1)
    expect(stub.specs[0]?.pattern).toBe('**/*.ts')
  })

  it('fails the search when a listener swallows the event', async () => {
    const { root, service, stub } = harness()
    root.on('search/pre-search', () => undefined)

    await expect(service.findFiles(service.resolveFindFiles({ pattern: '**/*.ts' })))
      .rejects.toMatchObject({ name: 'SearchError', code: 'SEARCH_FAILED' })
    expect(stub.specs).toHaveLength(0)
  })

  it('rejects a rewrite that drops the spec', async () => {
    const { root, service, stub } = harness()
    root.on('search/pre-search', (event: FindFilesPreEvent, next: () => unknown) => {
      ;(event as { spec: unknown }).spec = { root: '.', pattern: '**/*.ts' }
      return next()
    })

    await expect(service.findFiles(service.resolveFindFiles({ pattern: '**/*.ts' })))
      .rejects.toMatchObject({ code: 'SEARCH_FAILED' })
    expect(stub.specs).toHaveLength(0)
  })
})

describe('search/post-search', () => {
  it('lets a listener rewrite the result after the provider ran', async () => {
    const { root, service, stub } = harness()
    stub.files = { paths: ['src/a.ts', '.env'], truncated: true }
    const before: FindFilesResult[] = []
    root.on('search/post-search', (event: SearchPostEvent, next: () => unknown) => {
      if (event.op !== 'findFiles') return next()
      before.push({ paths: [...event.result.paths], truncated: event.result.truncated })
      event.result = {
        paths: event.result.paths.filter(path => !path.startsWith('.')),
        truncated: false,
      }
      return next()
    })

    const result = await service.findFiles(service.resolveFindFiles({ pattern: '**/*.ts' }))

    expect(before).toEqual([{ paths: ['src/a.ts', '.env'], truncated: true }])
    expect(result).toEqual({ paths: ['src/a.ts'], truncated: false })
  })

  it('rejects a rewrite that is not a valid result', async () => {
    const { root, service } = harness()
    root.on('search/post-search', (event: SearchPostEvent, next: () => unknown) => {
      ;(event as { result: unknown }).result = { paths: 'nope' }
      return next()
    })

    await expect(service.findFiles(service.resolveFindFiles({ pattern: '**/*.ts' })))
      .rejects.toMatchObject({ code: 'SEARCH_FAILED' })
  })
})

describe('search/result', () => {
  it('notifies with the resolved spec, the result and the duration', async () => {
    const { root, service, stub } = harness()
    stub.files = { paths: ['src/a.ts'], truncated: true }
    const events: FindFilesResultEvent[] = []
    root.on('search/result', (event: FindFilesResultEvent) => {
      events.push(event)
    })

    const result = await service.findFiles(service.resolveFindFiles({ pattern: '**/*.ts' }))

    expect(result).toEqual({ paths: ['src/a.ts'], truncated: true })
    expect(events).toHaveLength(1)
    expect(events[0]?.op).toBe('findFiles')
    expect(events[0]?.spec.pattern).toBe('**/*.ts')
    expect(events[0]?.result).toEqual({ paths: ['src/a.ts'], truncated: true })
    expect(events[0]?.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('reports the spec that actually ran, not the requested one', async () => {
    const { root, service } = harness()
    root.on('search/pre-search', (event: FindFilesPreEvent, next: () => unknown) => {
      event.spec = { ...event.spec, maxResults: 3 }
      return next()
    })
    const events: FindFilesResultEvent[] = []
    root.on('search/result', (event: FindFilesResultEvent) => {
      events.push(event)
    })

    await service.findFiles(service.resolveFindFiles({ pattern: '**/*.ts' }))

    expect(events[0]?.spec.maxResults).toBe(3)
  })

  it('keeps the authoritative result when an observer throws', async () => {
    const { root, service, stub } = harness()
    stub.files = { paths: ['src/a.ts'], truncated: false }
    root.on('search/result', () => {
      throw new Error('audit sink is down')
    })

    await expect(service.findFiles(service.resolveFindFiles({ pattern: '**/*.ts' })))
      .resolves.toEqual({ paths: ['src/a.ts'], truncated: false })
  })
})

describe('search/error', () => {
  it('carries the failure and keeps the rejection intact', async () => {
    const { root, service, stub } = harness()
    const failure = new SearchError('rg exploded', 'SEARCH_FAILED')
    stub.failure = failure
    const events: SearchErrorEvent[] = []
    root.on('search/error', (event: SearchErrorEvent) => {
      events.push(event)
    })

    await expect(service.findFiles(service.resolveFindFiles({ pattern: '**/*.ts' })))
      .rejects.toBe(failure)

    expect(events).toHaveLength(1)
    expect(events[0]?.op).toBe('findFiles')
    expect(events[0]?.error).toBe(failure)
    expect(events[0]?.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('does not mask the failure when an observer throws', async () => {
    const { root, service, stub } = harness()
    const failure = new SearchError('rg exploded', 'SEARCH_FAILED')
    stub.failure = failure
    root.on('search/error', () => {
      throw new Error('audit sink is down')
    })

    await expect(service.findFiles(service.resolveFindFiles({ pattern: '**/*.ts' })))
      .rejects.toBe(failure)
  })

  it('is not dispatched for an empty result, because that is not a failure', async () => {
    const { root, service } = harness()
    const events: SearchErrorEvent[] = []
    root.on('search/error', (event: SearchErrorEvent) => {
      events.push(event)
    })

    await expect(service.findFiles(service.resolveFindFiles({ pattern: '**/*.ts' })))
      .resolves.toEqual({ paths: [], truncated: false })
    expect(events).toHaveLength(0)
  })
})

describe('the event face covers both operations', () => {
  it('runs the same sequence for a content search', async () => {
    const { root, service, stub } = harness()
    stub.matches = { matches: [{ file: 'a.md', line: 2, text: 'value' }], truncated: false }
    const sequence: string[] = []
    root.on('search/pre-search', (event: SearchPreEvent, next: () => unknown) => {
      sequence.push(`pre:${event.op}`)
      return next()
    })
    root.on('search/post-search', (event: SearchPostEvent, next: () => unknown) => {
      sequence.push(`post:${event.op}`)
      return next()
    })
    root.on('search/result', (event: SearchTextResultEvent) => {
      sequence.push(`result:${event.op}`)
    })

    const result = await service.searchText(service.resolveSearchText({ pattern: 'value' }))

    expect(result).toEqual({
      matches: [{ file: 'a.md', line: 2, text: 'value' }],
      truncated: false,
    })
    expect(sequence).toEqual(['pre:searchText', 'post:searchText', 'result:searchText'])
    expect(stub.textSpecs).toHaveLength(1)
  })
})

describe('event lifecycle', () => {
  it('is observable through ctx.search, not only on the raw provider', async () => {
    const { root, stub } = harness()
    stub.files = { paths: ['from-stub.ts'], truncated: false }
    const events: FindFilesResultEvent[] = []
    root.on('search/result', (event: FindFilesResultEvent) => {
      events.push(event)
    })

    const resolved: SearchService = root.get('search')
    await expect(resolved.findFiles(resolved.resolveFindFiles({ pattern: '**/*.ts' })))
      .resolves.toEqual({ paths: ['from-stub.ts'], truncated: false })
    expect(events).toHaveLength(1)
  })

  it('removes listeners when the mounting fiber is disposed', async () => {
    const { root, service, stub } = harness()
    const events: FindFilesResultEvent[] = []
    const fiber = root.plugin((ctx) => {
      ctx.on('search/result', (event: FindFilesResultEvent) => {
        events.push(event)
      })
    })
    await fiber

    await service.findFiles(service.resolveFindFiles({ pattern: '**/*.ts' }))
    expect(events).toHaveLength(1)

    await fiber.dispose()
    await service.findFiles(service.resolveFindFiles({ pattern: '**/*.ts' }))
    expect(events).toHaveLength(1)
    expect(stub.specs).toHaveLength(2)
  })
})
