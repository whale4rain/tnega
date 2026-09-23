import { Service, type Context } from '@tnega/core'

declare module '@tnega/core' {
  interface Context {
    spillStore: SpillStore
  }
}

export type SpillErrorCode =
  /** 存储真的失败了：权限、磁盘、后端不可用。 */
  | 'SPILL_FAILED'
  /** 请求本身不合法，后端拒绝落盘。 */
  | 'SPILL_INVALID'

export class SpillError extends Error {
  override name = 'SpillError'

  constructor(
    message: string,
    readonly code: SpillErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

/** 落盘产物的归属；同一会话的产物聚在一起，便于按生命周期清理。 */
export interface SpillOwner {
  sessionId: string
}

/** 产物从哪来。目前只有工具结果一种来源，形状留在这里以便扩充。 */
export interface ToolSpillSource {
  kind: 'tool'
  toolName: string
  callId: string
  /** 结果里的哪一部分，默认 `output`。 */
  label?: string
}

export type SpillSource = ToolSpillSource

export interface SaveTextSpill {
  source: SpillSource
  /**
   * 文件名建议。**只是建议**：后端会把它压成一个安全的路径片段，绝不当作路径，
   * 调用方不得依赖它决定读写位置。
   */
  suggestedName: string
  content: string
  owner?: SpillOwner
}

export interface SpillRef {
  /** 面向模型的不透明句柄；本地后端返回的是可读路径。消费者只渲染，不解析。 */
  locator: string
  /** 实际写入的 UTF-8 字节数。 */
  bytes: number
  /** 消费者转述给模型的取回指引。 */
  retrievalHint: string
}

/**
 * 溢出存储能力的 Service Definition：把过大的文本存到别处，换回一个可检索的定位符。
 *
 * 契约（照 dsh `SpillStore` 的口径）：
 *
 * - **只有一种方法**。本缝不做保留策略、不做结果替换、不提供读取或检索 API ——
 *   何时溢出由 Consumer 决定，怎么存由 Provider 决定。
 * - **拒绝，不静默降级**。存储失败就 reject：调用方自己决定是保留原文还是失败，
 *   缝不替它做决定。
 * - **定位符不透明**。消费者只把它和 `retrievalHint` 一起渲染，不解析、不拼接。
 *
 * 本包只承载契约与词汇，自己不注册任何服务；Provider 子类化 {@link SpillStore}
 * 后以插件形式挂载。
 */
export abstract class SpillStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'spillStore')
  }

  /**
   * 保存一段完整文本，返回可检索的定位符。
   *
   * @throws SpillError 存储失败（`SPILL_FAILED`）或请求非法（`SPILL_INVALID`）。
   */
  abstract saveText(request: SaveTextSpill): Promise<SpillRef>
}

export default SpillStore
