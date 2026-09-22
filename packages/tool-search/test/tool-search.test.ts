import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, type Plugin } from '@tnega/core'
import { resolveRipgrepPath, searchRipgrep } from '@tnega/search-ripgrep'
import {
  SearchService,
  type FindFilesRequest,
  type FindFilesResult,
  type FindFilesSpec,
  type SearchMatch,
  type SearchTextRequest,
  type SearchTextResult,
  type SearchTextSpec,
} from '@tnega/search'
import { tools, type ToolsService } from '@tnega/tools'
import { toolSearch } from '../src/index.js'

const dirs: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

interface FakeAnswers {
  files?: string[]
  matches?: SearchMatch[]
  truncated?: boolean
}

/**
 * 随便一个 Provider：它证明 Consumer 只认识能力契约。任何符合 `SearchService` 的
 * 实现都应该让同一个 `expectSearchContract` 原样通过。
 */
class FakeSearch extends SearchService {
  readonly findSpecs: FindFilesSpec[] = []
  readonly textSpecs: SearchTextSpec[] = []
  private readonly _answers: FakeAnswers

  constructor(ctx: Context, answers: FakeAnswers = {}) {
    super(ctx)
    this._answers = answers
  }

  override resolveFindFiles(request: FindFilesRequest): FindFilesSpec {
    return {
      ...this._base(request.path, request.maxResults, request.signal),
      pattern: request.pattern,
    }
  }

  override resolveSearchText(request: SearchTextRequest): SearchTextSpec {
    return {
      ...this._base(request.path, request.maxResults, request.signal),
      pattern: request.pattern,
      ...(request.glob !== undefined ? { glob: request.glob } : {}),
    }
  }

  override async findFiles(spec: FindFilesSpec): Promise<FindFilesResult> {
    this.findSpecs.push(spec)
    return { paths: this._answers.files ?? [], truncated: this._answers.truncated ?? false }
  }

  override async searchText(spec: SearchTextSpec): Promise<SearchTextResult> {
    this.textSpecs.push(spec)
    return { matches: this._answers.matches ?? [], truncated: this._answers.truncated ?? false }
  }

  private _base(
    path: string | undefined,
    maxResults: number | undefined,
    signal: AbortSignal | undefined,
  ): Omit<FindFilesSpec, 'pattern'> {
    return {
      root: path ?? '.',
      maxResults: maxResults ?? 200,
      excludes: ['node_modules'],
      respectGitignore: true,
      maxOutputBytes: 1_000_000,
      timeoutMs: 30_000,
      ...(signal ? { signal } : {}),
    }
  }
}

function fakeProvider(answers: FakeAnswers): {
  plugin: Plugin
  instances: FakeSearch[]
} {
  const instances: FakeSearch[] = []
  return {
    instances,
    plugin: {
      name: 'search-fake',
      apply(ctx: Context) {
        instances.push(new FakeSearch(ctx, answers))
      },
    },
  }
}

async function mountSearch(provider: Plugin, cwd: string): Promise<ToolsService> {
  const root = new Context()
  await root.plugin(tools)
  await root.plugin(provider, { cwd })
  await root.plugin(toolSearch, { cwd })
  return root.get('tools') as ToolsService
}

async function ok(service: ToolsService, name: string, input: unknown): Promise<unknown> {
  const result = await service.execute(name, input)
  expect(result.ok, result.error?.message).toBe(true)
  return result.output
}

describe('glob / grep through a fake provider', () => {
  it('registers both tools and returns the provider result unchanged', async () => {
    const cwd = await tempDir('tnega-tool-search-')
    const provider = fakeProvider({ files: ['src/a.ts', 'src/b.ts'] })
    const service = await mountSearch(provider.plugin, cwd)

    expect(service.list().map(tool => tool.schema.name).sort()).toEqual(['glob', 'grep'])
    expect(await ok(service, 'glob', { pattern: '**/*.ts' }))
      .toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('hands a resolved spec to the capability instead of argv to a process', async () => {
    const cwd = await tempDir('tnega-tool-search-')
    const provider = fakeProvider({ matches: [{ file: 'a.md', line: 3, text: 'value' }] })
    const service = await mountSearch(provider.plugin, cwd)

    expect(await ok(service, 'grep', { pattern: 'value', glob: '**/*.md', maxResults: 7 }))
      .toEqual([{ file: 'a.md', line: 3, text: 'value' }])

    const [spec] = provider.instances[0]!.textSpecs
    expect(spec).toMatchObject({
      root: '.',
      pattern: 'value',
      glob: '**/*.md',
      maxResults: 7,
    })
  })

  it('normalizes the glob pattern before it reaches the capability', async () => {
    const cwd = await tempDir('tnega-tool-search-')
    const provider = fakeProvider({})
    const service = await mountSearch(provider.plugin, cwd)

    await ok(service, 'glob', { pattern: '.\\src\\**\\*.ts' })
    expect(provider.instances[0]!.findSpecs[0]!.pattern).toBe('src/**/*.ts')
  })

  it('sandboxes the requested root before it reaches the capability', async () => {
    const cwd = await tempDir('tnega-tool-search-')
    const provider = fakeProvider({})
    const service = await mountSearch(provider.plugin, cwd)

    const escape = await service.execute('glob', { pattern: '**', base: '..' })
    expect(escape.ok).toBe(false)
    expect(escape.error?.message).toContain('escapes')
    expect(provider.instances[0]!.findSpecs).toHaveLength(0)
  })

  it('declares the tool timeout on both tools', async () => {
    const cwd = await tempDir('tnega-tool-search-')
    const service = await mountSearch(fakeProvider({}).plugin, cwd)
    for (const tool of service.list()) {
      expect(tool.timeoutMs).toBe(30_000)
    }
  })

  it('honours the disabled list', async () => {
    const cwd = await tempDir('tnega-tool-search-')
    const root = new Context()
    await root.plugin(tools)
    await root.plugin(fakeProvider({}).plugin, { cwd })
    await root.plugin(toolSearch, { cwd, disabled: ['grep'] })
    const service = root.get('tools') as ToolsService

    expect(service.list().map(tool => tool.schema.name)).toEqual(['glob'])
  })
})

/**
 * 同一条断言集，用来证明换 Provider 时 Consumer 侧零改动。只断言能力契约本身
 * （返回形态与结果顺序），不含任何具体 Provider 的语义。
 */
async function expectSearchContract(service: ToolsService): Promise<void> {
  expect(await ok(service, 'glob', { pattern: '**/*.ts' })).toEqual(['src/a.ts'])
  expect(await ok(service, 'grep', { pattern: 'value' }))
    .toEqual([{ file: 'src/a.ts', line: 1, text: 'export const value = 1' }])
}

describe('the seam survives a provider swap', () => {
  it('passes the same contract against a fake provider', async () => {
    const cwd = await tempDir('tnega-tool-search-seam-fake-')
    const service = await mountSearch(fakeProvider({
      files: ['src/a.ts'],
      matches: [{ file: 'src/a.ts', line: 1, text: 'export const value = 1' }],
    }).plugin, cwd)
    await expectSearchContract(service)
  })

  it('passes the same contract against the ripgrep provider', async (context) => {
    const cwd = await tempDir('tnega-tool-search-seam-rg-')
    await mkdir(join(cwd, 'src'), { recursive: true })
    await mkdir(join(cwd, 'ignored'), { recursive: true })
    await writeFile(join(cwd, '.gitignore'), 'ignored/\n', 'utf8')
    await writeFile(join(cwd, 'src', 'a.ts'), 'export const value = 1\n', 'utf8')
    await writeFile(join(cwd, 'ignored', 'b.ts'), 'export const value = 2\n', 'utf8')

    try {
      await resolveRipgrepPath()
    } catch {
      context.skip()
      return
    }

    const service = await mountSearch(searchRipgrep, cwd)
    await expectSearchContract(service)
    // 这是 ripgrep Provider 的语义（.gitignore 生效），不属于能力契约本身。
    expect(await ok(service, 'glob', { pattern: '**/*.ts' })).toEqual(['src/a.ts'])
    expect(await ok(service, 'glob', { pattern: '**/*.ts', base: 'ignored' }))
      .toEqual(['ignored/b.ts'])
  })

  it('treats a bare "*" as the search root entries, not the whole tree', async (context) => {
    const cwd = await tempDir('tnega-tool-search-star-')
    await mkdir(join(cwd, 'src', 'deep'), { recursive: true })
    await writeFile(join(cwd, 'top.ts'), 'x', 'utf8')
    await writeFile(join(cwd, 'src', 'a.ts'), 'y', 'utf8')
    await writeFile(join(cwd, 'src', 'deep', 'b.ts'), 'z', 'utf8')

    try {
      await resolveRipgrepPath()
    } catch {
      context.skip()
      return
    }

    const service = await mountSearch(searchRipgrep, cwd)
    expect(await ok(service, 'glob', { pattern: '*' })).toEqual(['top.ts'])
    expect((await ok(service, 'glob', { pattern: '**/*.ts' }) as string[]).sort())
      .toEqual(['src/a.ts', 'src/deep/b.ts', 'top.ts'])
  })
})
