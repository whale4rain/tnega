import { Service, type Context } from '@tnega/core'
import {
  normalizeError,
  notifyError,
  notifyResult,
  postFindFiles,
  postSearchText,
  preFindFiles,
  preSearchText,
} from './events.js'
import type {
  FindFilesRequest,
  FindFilesResult,
  FindFilesResultEvent,
  FindFilesSpec,
  SearchErrorEvent,
  SearchTextRequest,
  SearchTextResult,
  SearchTextResultEvent,
  SearchTextSpec,
} from './types.js'

export * from './types.js'
export * from './events.js'

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
 * - **显式优于隐式**：`resolve*` 是默认值与上限唯一的落点，`runFindFiles` /
 *   `runSearchText` 内部不得再出现 `?? 默认值`。
 * - **一次组合只挂一个 Provider**：同一个作用域注册第二个 Provider 会直接失败。
 * - **事件面属于本包**：`findFiles` / `searchText` 是基类上的模板方法，事件在基类
 *   统一派发；Provider 只实现 `run*`，因此任何 Provider 都自动参与全部事件，
 *   也不可能绕过它们。（与 `@tnega/agent` 的 `agent/*`、`@tnega/tools` 的
 *   `tools/*` 同构，占位符是字符串事件名。）
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
   * 真正执行文件发现。只由基类的 `findFiles` 调用，Provider 不自行派发事件。
   */
  protected abstract runFindFiles(spec: FindFilesSpec): Promise<FindFilesResult>

  /**
   * 真正执行内容检索。只由基类的 `searchText` 调用，Provider 不自行派发事件。
   */
  protected abstract runSearchText(spec: SearchTextSpec): Promise<SearchTextResult>

  /**
   * 按 spec 发现文件。返回工作区相对路径。
   *
   * 事件序列：`search/pre-search`（可改写 spec）→ Provider（`runFindFiles`）→
   * `search/post-search`（可改写结果）→ `search/result`；任一环节失败时改派
   * `search/error` 并以原始失败拒绝。
   *
   * @throws SearchError 基础设施失败（pattern 非法、搜索无法运行、输出溢出、中断）。
   */
  async findFiles(spec: FindFilesSpec): Promise<FindFilesResult> {
    const startedAt = Date.now()
    let active = spec
    try {
      active = await preFindFiles(this.ctx, spec)
      const result = await postFindFiles(this.ctx, active, await this.runFindFiles(active))
      await notifyResult(this.ctx, {
        op: 'findFiles',
        spec: active,
        result,
        startedAt,
        durationMs: Date.now() - startedAt,
      } satisfies FindFilesResultEvent)
      return result
    } catch (error) {
      await notifyError(this.ctx, {
        op: 'findFiles',
        spec: active,
        error: normalizeError(error),
        startedAt,
        durationMs: Date.now() - startedAt,
      } satisfies SearchErrorEvent)
      throw error
    }
  }

  /**
   * 按 spec 检索文件内容。
   *
   * 事件序列与 {@link SearchService.findFiles} 相同，方向是 `searchText`。
   *
   * @throws SearchError 基础设施失败（pattern 非法、搜索无法运行、输出溢出、中断）。
   */
  async searchText(spec: SearchTextSpec): Promise<SearchTextResult> {
    const startedAt = Date.now()
    let active = spec
    try {
      active = await preSearchText(this.ctx, spec)
      const result = await postSearchText(this.ctx, active, await this.runSearchText(active))
      await notifyResult(this.ctx, {
        op: 'searchText',
        spec: active,
        result,
        startedAt,
        durationMs: Date.now() - startedAt,
      } satisfies SearchTextResultEvent)
      return result
    } catch (error) {
      await notifyError(this.ctx, {
        op: 'searchText',
        spec: active,
        error: normalizeError(error),
        startedAt,
        durationMs: Date.now() - startedAt,
      } satisfies SearchErrorEvent)
      throw error
    }
  }
}

export default SearchService

export const name = '@tnega/search'
