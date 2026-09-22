/**
 * 工作区搜索能力的词汇：请求形态、完全解析后的 spec、结果形态，以及稳定的错误码。
 * 这里只有类型与常量，没有 I/O，也没有任何具体检索机制的词汇（ripgrep、argv、
 * `--json` 都属于 Provider）。
 */

/** 稳定、可路由的搜索失败码。 */
export type SearchErrorCode =
  /** 匹配器拒绝了 pattern。 */
  | 'SEARCH_INVALID_PATTERN'
  /** 搜索根不是工作区内的相对路径。 */
  | 'SEARCH_INVALID_PATH'
  /** 搜索无法运行（二进制缺失、进程失败、输出无法解析）。 */
  | 'SEARCH_FAILED'
  /** 原始输出超出上限，拒绝把半截结果当成完整结果。 */
  | 'SEARCH_OUTPUT_OVERFLOW'
  /** 调用方中断或工具超时。 */
  | 'SEARCH_ABORTED'

/**
 * 带稳定错误码的搜索失败。只有基础设施失败才以它 reject：pattern 无匹配、命中结果
 * 上限都属于正常结果。
 */
export class SearchError extends Error {
  override name = 'SearchError'

  constructor(
    message: string,
    readonly code: SearchErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

/**
 * 一次文件发现的请求。`path` 是工作区相对路径，`maxResults` 由
 * {@link SearchService.resolveFindFiles} 解析出默认值。
 */
export interface FindFilesRequest {
  /** glob pattern，例如 `**\/*.ts`。 */
  pattern: string
  /** 搜索根，默认工作区根。 */
  path?: string
  /** 结果条数上限。 */
  maxResults?: number
  /** 中断信号，Provider 必须据此终止搜索。 */
  signal?: AbortSignal
}

/** 一次内容检索的请求。 */
export interface SearchTextRequest {
  /** 正则 pattern，由 Provider 的匹配引擎解释。 */
  pattern: string
  /** 搜索根，默认工作区根。 */
  path?: string
  /** 可选的候选文件过滤 glob，例如 `**\/*.md`。 */
  glob?: string
  /** 结果条数上限。 */
  maxResults?: number
  /** 中断信号，Provider 必须据此终止搜索。 */
  signal?: AbortSignal
}

/**
 * 请求与 spec 共有的、已被完全解析的部分。所有默认值与上限都在
 * `resolve*` 里落定，`findFiles` / `searchText` 内部不再出现 `?? 默认值`。
 */
export interface SearchSpecBase {
  /** 搜索根，工作区相对路径；已校验不含 `..`、不是绝对路径。 */
  root: string
  /** 结果条数上限。 */
  maxResults: number
  /** 遍历时跳过的目录名。 */
  excludes: readonly string[]
  /** 是否让工作区的 `.gitignore` 过滤搜索。 */
  respectGitignore: boolean
  /** 原始输出上限（字节）。 */
  maxOutputBytes: number
  /** 单次搜索的时间预算（毫秒）。 */
  timeoutMs: number
  /** 中断信号。 */
  signal?: AbortSignal
}

/** 一次文件发现的完全解析形态。 */
export interface FindFilesSpec extends SearchSpecBase {
  pattern: string
}

/** 一次内容检索的完全解析形态。 */
export interface SearchTextSpec extends SearchSpecBase {
  pattern: string
  glob?: string
}

/** 一次文件发现的结果。`truncated` 表示结果上限生效，不是失败。 */
export interface FindFilesResult {
  /** 工作区相对路径。 */
  paths: string[]
  truncated: boolean
}

/** 一条内容命中。 */
export interface SearchMatch {
  /** 工作区相对路径。 */
  file: string
  /** 1 起的行号。 */
  line: number
  /** 命中行文本，已去掉行尾换行。 */
  text: string
}

/** 一次内容检索的结果。`truncated` 表示结果上限生效，不是失败。 */
export interface SearchTextResult {
  matches: SearchMatch[]
  truncated: boolean
}

/**
 * 遍历时默认跳过的目录名。这些名字命名的是能力本身要绕开的东西（版本控制元数据
 * 与依赖树），不是某个实现的选择，所以由本包而不是 Provider 导出。
 */
export const DEFAULT_SEARCH_EXCLUDES: readonly string[] = [
  '.git',
  '.svn',
  '.hg',
  '.bzr',
  '.jj',
  '.sl',
  'node_modules',
]

/** 单次搜索的默认时间预算（毫秒）。 */
export const DEFAULT_SEARCH_TIMEOUT_MS = 30_000

/** 单次搜索解析的原始输出默认上限（字节）。 */
export const DEFAULT_SEARCH_OUTPUT_MAX_BYTES = 20_000_000

/** 单次搜索的默认结果条数上限。 */
export const DEFAULT_SEARCH_MAX_RESULTS = 200
