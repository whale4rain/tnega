import { relative, sep } from 'node:path'
import type { Context } from '@tnega/core'
import {
  DEFAULT_SEARCH_MAX_RESULTS,
  DEFAULT_SEARCH_TIMEOUT_MS,
  type SearchService,
} from '@tnega/search'
import {
  resolveInside,
  type ToolDefinition,
  type ToolExecuteOptions,
  type ToolsService,
} from '@tnega/tools'
import { optionalNumber, optionalString, record, stringField } from './input.js'

/** `glob` / `grep` 两个模型可见工具的配置。 */
export interface ToolSearchConfig {
  /** 工作区根，工具沙箱的基准。 */
  cwd?: string
  /** 关闭其中一个工具。 */
  disabled?: readonly string[]
  /** 工具调用的协作式时间预算，写进 `ToolDefinition.timeoutMs`。 */
  searchTimeoutMs?: number
  /** 默认结果条数上限。 */
  maxResults?: number
}

interface ResolvedConfig {
  cwd: string
  disabled: ReadonlySet<string>
  searchTimeoutMs: number
  maxResults: number
}

function normalizeConfig(config: ToolSearchConfig): ResolvedConfig {
  return {
    cwd: config.cwd ?? process.cwd(),
    disabled: new Set(config.disabled ?? []),
    searchTimeoutMs: config.searchTimeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS,
    maxResults: config.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS,
  }
}

function displayPath(cwd: string, target: string): string {
  const rel = relative(cwd, target)
  return (rel === '' ? '.' : rel).split(sep).join('/')
}

/**
 * 用与其它文件工具相同的 `resolveInside` 约束搜索根：拒绝绝对路径、`..` 越界与
 * symlink 越界，再把结果规范化成工作区相对路径交给能力。Provider 会再校验一次
 * 相对且不含 `..`。
 */
async function searchRoot(
  config: ResolvedConfig,
  input: string | undefined,
): Promise<string | undefined> {
  if (input === undefined) return undefined
  return displayPath(config.cwd, await resolveInside(config.cwd, input))
}

function globTool(service: SearchService, config: ResolvedConfig): ToolDefinition {
  return {
    schema: {
      name: 'glob',
      description: 'Find files inside the workspace by glob pattern, honoring the workspace .gitignore. `**` matches across path segments; `*` and `?` stay within one; `{a,b}` alternates. Patterns are matched against workspace-relative paths, so use `**/*.ts` to find TypeScript files at any depth — `*.ts` matches only the search root\'s own entries. Returns workspace-relative paths, most recently modified first.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'glob pattern, e.g. "**/*.ts"' },
          base: { type: 'string', description: 'directory to search, defaults to workspace root' },
        },
        required: ['pattern'],
      },
    },
    timeoutMs: config.searchTimeoutMs,
    async execute(input, options: ToolExecuteOptions) {
      const args = record(input)
      const pattern = stringField(args.pattern, 'pattern')
        .replaceAll('\\', '/')
        .replace(/^\.\//, '')
      const root = await searchRoot(config, optionalString(args.base, 'base'))
      const spec = service.resolveFindFiles({
        pattern,
        ...(root !== undefined ? { path: root } : {}),
        maxResults: config.maxResults,
        ...(options.signal ? { signal: options.signal } : {}),
      })
      return (await service.findFiles(spec)).paths
    },
  }
}

function grepTool(service: SearchService, config: ResolvedConfig): ToolDefinition {
  return {
    schema: {
      name: 'grep',
      description: 'Search text files for a regular expression, honoring the workspace .gitignore. Returns [{ file, line, text }].',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'regular expression to search for' },
          path: { type: 'string', description: 'directory to search, defaults to workspace root' },
          glob: { type: 'string', description: 'optional file glob filter matched like `glob` (use `**/*.md` for any depth), e.g. "**/*.md"' },
          maxResults: { type: 'number', description: 'optional result limit' },
        },
        required: ['pattern'],
      },
    },
    timeoutMs: config.searchTimeoutMs,
    async execute(input, options: ToolExecuteOptions) {
      const args = record(input)
      const root = await searchRoot(config, optionalString(args.path, 'path'))
      const glob = optionalString(args.glob, 'glob')
      const spec = service.resolveSearchText({
        pattern: stringField(args.pattern, 'pattern'),
        ...(root !== undefined ? { path: root } : {}),
        ...(glob !== undefined ? { glob } : {}),
        maxResults: optionalNumber(args.maxResults, 'maxResults') ?? config.maxResults,
        ...(options.signal ? { signal: options.signal } : {}),
      })
      return (await service.searchText(spec)).matches
    },
  }
}

export const name = 'tool-search'

export function apply(ctx: Context, config: ToolSearchConfig = {}): void {
  const resolved = normalizeConfig(config)
  const registry = ctx.get('tools') as ToolsService
  if (!resolved.disabled.has('glob')) registry.register(globTool(ctx.search, resolved))
  if (!resolved.disabled.has('grep')) registry.register(grepTool(ctx.search, resolved))
}

/**
 * 模型可见的 `glob` / `grep`：只有这里拥有工具的 name、description、JSON schema 与
 * 结果形状。工具只经 `ctx.search` 进入能力，不枚举 Provider、不探测可用性，也不
 * import 任何具体 Provider 包。
 *
 * 挂载：`await ctx.plugin(toolSearch, { cwd })`。
 */
export const toolSearch = {
  name: 'tool-search',
  /** 依赖注册表与被缝化的搜索能力；Provider 由 composition 层单独挂载。 */
  inject: ['tools', 'search'],
  apply,
}

export const DEFAULT_TOOL_SEARCH_NAMES: readonly string[] = ['glob', 'grep']
