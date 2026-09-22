import { Service, type Context } from '@tnega/core'
import type {
  FindFilesRequest,
  FindFilesResult,
  FindFilesSpec,
  SearchTextRequest,
  SearchTextResult,
  SearchTextSpec,
} from './types.js'

export * from './types.js'

declare module '@tnega/core' {
  interface Context {
    search: SearchService
  }
}

/**
 * 工作区搜索能力的 Service Definition：文件发现与内容检索。拥有 `ctx.search`，
 * 只承载契约与词汇；具体检索机制（进程、索引、远程沙箱）由 Service Provider 提供，
 * 模型可见的 `glob` / `grep` 工具由 Consumer 提供。
 *
 * 契约（与 `@tnega/execution` 的 shell 语义一致）：
 *
 * - **结果与拒绝分开**：pattern 无匹配、命中结果上限都是正常结果（后者以
 *   `truncated` 标记）；只有基础设施失败才以 {@link SearchError} reject。
 * - **显式优于隐式**：`resolve*` 是默认值与上限唯一的落点，`findFiles` /
 *   `searchText` 内部不得再出现 `?? 默认值`。
 * - **一次组合只挂一个 Provider**：同一个作用域注册第二个 Provider 会直接失败。
 */
export abstract class SearchService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'search')
  }

  /** 把文件发现请求解析成完全显式的 spec。 */
  abstract resolveFindFiles(request: FindFilesRequest): FindFilesSpec

  /** 把内容检索请求解析成完全显式的 spec。 */
  abstract resolveSearchText(request: SearchTextRequest): SearchTextSpec

  /**
   * 按 spec 发现文件。返回工作区相对路径。
   *
   * @throws SearchError 基础设施失败（pattern 非法、搜索无法运行、输出溢出、中断）。
   */
  abstract findFiles(spec: FindFilesSpec): Promise<FindFilesResult>

  /**
   * 按 spec 检索文件内容。
   *
   * @throws SearchError 基础设施失败（pattern 非法、搜索无法运行、输出溢出、中断）。
   */
  abstract searchText(spec: SearchTextSpec): Promise<SearchTextResult>
}

export default SearchService

export const name = '@tnega/search'
