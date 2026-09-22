import { isAbsolute } from 'node:path'
import type { Context } from '@tnega/core'
import {
  localExecutionProvider,
  type ExecutionProvider,
  type ProcessResult,
} from '@tnega/execution'
import {
  DEFAULT_SEARCH_EXCLUDES,
  DEFAULT_SEARCH_MAX_RESULTS,
  DEFAULT_SEARCH_OUTPUT_MAX_BYTES,
  DEFAULT_SEARCH_TIMEOUT_MS,
  SearchError,
  SearchService,
  type FindFilesRequest,
  type FindFilesResult,
  type FindFilesSpec,
  type SearchSpecBase,
  type SearchTextRequest,
  type SearchTextResult,
  type SearchTextSpec,
} from '@tnega/search'
import { buildGlobArgv, buildGrepArgv } from './argv.js'
import { resolveRipgrepPath } from './binary.js'
import { assertSearchSucceeded, parseGlobPaths, parseGrepMatches } from './parse.js'

/** ripgrep 的本次实现可配置项；未给的字段取 Service Definition 的能力默认值。 */
export interface Config {
  /** 工作区根，搜索进程的工作目录。 */
  cwd?: string
  /** ripgrep 二进制路径；未给时在 `PATH` 上找 `rg`。 */
  ripgrepPath?: string
  /** 是否让工作区 `.gitignore` 过滤搜索。 */
  respectGitignore?: boolean
  /** 遍历时跳过的目录名。 */
  excludes?: readonly string[]
  /** 时间预算（毫秒）。 */
  timeoutMs?: number
  /** 原始输出上限（字节）。 */
  maxOutputBytes?: number
  /** 结果条数上限。 */
  maxResults?: number
  /** 进程执行边界；默认本机实现。 */
  execution?: ExecutionProvider
}

interface ResolvedConfig {
  cwd: string
  ripgrepPath: string | undefined
  respectGitignore: boolean
  excludes: readonly string[]
  timeoutMs: number
  maxOutputBytes: number
  maxResults: number
  execution: ExecutionProvider
}

function normalizeConfig(config: Config): ResolvedConfig {
  return {
    cwd: config.cwd ?? process.cwd(),
    ripgrepPath: config.ripgrepPath,
    respectGitignore: config.respectGitignore ?? true,
    excludes: [...(config.excludes ?? DEFAULT_SEARCH_EXCLUDES)],
    timeoutMs: config.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS,
    maxOutputBytes: config.maxOutputBytes ?? DEFAULT_SEARCH_OUTPUT_MAX_BYTES,
    maxResults: config.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS,
    execution: config.execution ?? localExecutionProvider,
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 把请求里的搜索根规范成工作区相对路径，并拒绝逃逸。
 *
 * @throws SearchError `SEARCH_INVALID_PATH`。
 */
function resolveRoot(input: string | undefined): string {
  if (input === undefined) return '.'
  const normalized = input.replaceAll('\\', '/')
  const segments = normalized.split('/').filter(segment => segment !== '' && segment !== '.')
  const driveRelative = /^[A-Za-z]:/.test(normalized)
  if (isAbsolute(input) || driveRelative || segments.includes('..')) {
    throw new SearchError(
      `search root must stay inside the workspace: ${input}`,
      'SEARCH_INVALID_PATH',
    )
  }
  return segments.length > 0 ? segments.join('/') : '.'
}

/**
 * ripgrep 支撑的工作区搜索 Provider。`rg` 永远以固定 argv 向量启动，模型可控的值
 * 都是独立参数，中间没有 shell 层。
 */
export class RipgrepSearch extends SearchService {
  private readonly _config: ResolvedConfig

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this._config = normalizeConfig(config)
  }

  override resolveFindFiles(request: FindFilesRequest): FindFilesSpec {
    return {
      ...this._resolveBase(request),
      pattern: request.pattern,
    }
  }

  override resolveSearchText(request: SearchTextRequest): SearchTextSpec {
    return {
      ...this._resolveBase(request),
      pattern: request.pattern,
      ...(request.glob !== undefined ? { glob: request.glob } : {}),
    }
  }

  override async findFiles(spec: FindFilesSpec): Promise<FindFilesResult> {
    const stdout = await this._run(
      'findFiles',
      buildGlobArgv(spec.pattern, commandOptions(spec)),
      spec,
    )
    const paths = parseGlobPaths('findFiles', stdout)
    return {
      paths: paths.slice(0, spec.maxResults),
      truncated: paths.length > spec.maxResults,
    }
  }

  override async searchText(spec: SearchTextSpec): Promise<SearchTextResult> {
    const stdout = await this._run(
      'searchText',
      buildGrepArgv(spec.pattern, commandOptions(spec)),
      spec,
    )
    const matches = parseGrepMatches('searchText', stdout)
    return {
      matches: matches.slice(0, spec.maxResults),
      truncated: matches.length > spec.maxResults,
    }
  }

  /** 默认值与上限唯一的落点：run 方法里不再出现 `?? 默认值`。 */
  private _resolveBase(request: FindFilesRequest | SearchTextRequest): SearchSpecBase {
    return {
      root: resolveRoot(request.path),
      maxResults: request.maxResults ?? this._config.maxResults,
      excludes: this._config.excludes,
      respectGitignore: this._config.respectGitignore,
      maxOutputBytes: this._config.maxOutputBytes,
      timeoutMs: this._config.timeoutMs,
      ...(request.signal ? { signal: request.signal } : {}),
    }
  }

  private async _run(
    label: string,
    argv: readonly string[],
    spec: SearchSpecBase,
  ): Promise<string> {
    const binary = await resolveRipgrepPath(this._config.ripgrepPath)
    if (spec.signal?.aborted) {
      throw new SearchError(`${label} was aborted before it could start`, 'SEARCH_ABORTED')
    }
    let result: ProcessResult
    try {
      result = await this._config.execution.runProcess({
        argv: [binary, ...argv],
        cwd: this._config.cwd,
        timeoutMs: spec.timeoutMs,
        maxBuffer: spec.maxOutputBytes,
        ...(spec.signal ? { signal: spec.signal } : {}),
      })
    } catch (error) {
      if (spec.signal?.aborted) {
        throw new SearchError(`${label} was aborted before completion`, 'SEARCH_ABORTED', { cause: error })
      }
      throw new SearchError(`${label} could not run: ${message(error)}`, 'SEARCH_FAILED', { cause: error })
    }
    if (spec.signal?.aborted) {
      throw new SearchError(`${label} was aborted before completion`, 'SEARCH_ABORTED')
    }
    assertSearchSucceeded(label, result, spec.maxOutputBytes)
    return result.stdout
  }
}

function commandOptions(spec: SearchSpecBase): {
  path?: string
  respectGitignore: boolean
  excludes: readonly string[]
} {
  return {
    ...(spec.root !== '.' ? { path: spec.root } : {}),
    respectGitignore: spec.respectGitignore,
    excludes: spec.excludes,
  }
}

export default RipgrepSearch

export { resolveRipgrepPath } from './binary.js'

export const name = '@tnega/search-ripgrep'

/** 挂载入口：`await ctx.plugin(searchRipgrep, { cwd })`。 */
export const searchRipgrep = {
  name: 'search-ripgrep',
  apply(ctx: Context, config: Config = {}) {
    new RipgrepSearch(ctx, config)
  },
}
