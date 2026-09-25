import { Service, type Context } from '@tnega/core'

declare module '@tnega/core' {
  interface Context {
    artifacts: ArtifactStore
  }
}

export type ArtifactErrorCode =
  /** 请求本身不合法：空内容、非法哈希、超过上限。 */
  | 'ARTIFACT_INVALID'
  | 'ARTIFACT_NOT_FOUND'
  /** 存储真的失败了：权限、磁盘、后端不可用。 */
  | 'ARTIFACT_FAILED'

export class ArtifactError extends Error {
  override name = 'ArtifactError'

  constructor(
    message: string,
    readonly code: ArtifactErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024
export const DEFAULT_MEDIA_TYPE = 'application/octet-stream'
export const HASH_PATTERN = /^[0-9a-f]{64}$/

/**
 * 产物引用。哈希是内容摘要（sha256，十六进制小写），所以同一个内容只存一份，
 * 引用可以安全地写进 Blackboard 与消息信封。
 */
export interface ArtifactRef {
  hash: string
  size: number
  mediaType: string
}

export interface ArtifactPutRequest {
  content: string | Uint8Array
  /** 缺省时按内容类型推断：字符串是 `text/plain`，字节是 `application/octet-stream`。 */
  mediaType?: string
}

function assertHash(hash: unknown): asserts hash is string {
  if (typeof hash !== 'string' || !HASH_PATTERN.test(hash)) {
    throw new ArtifactError(`invalid artifact hash: ${String(hash)}`, 'ARTIFACT_INVALID')
  }
}

export function normalizePut(request: ArtifactPutRequest): Required<ArtifactPutRequest> {
  if (!request || typeof request !== 'object') {
    throw new ArtifactError('artifact put requires an object', 'ARTIFACT_INVALID')
  }
  const { content } = request
  if (typeof content !== 'string' && !(content instanceof Uint8Array)) {
    throw new ArtifactError('artifact content must be a string or Uint8Array', 'ARTIFACT_INVALID')
  }
  if (request.mediaType !== undefined
    && (typeof request.mediaType !== 'string' || !request.mediaType.trim())) {
    throw new ArtifactError('mediaType must be a non-empty string', 'ARTIFACT_INVALID')
  }
  return {
    content,
    mediaType: request.mediaType?.trim()
      ?? (typeof content === 'string' ? 'text/plain' : DEFAULT_MEDIA_TYPE),
  }
}

/**
 * 产物内容存储能力的 Service Definition：按内容哈希存取大块内容。
 *
 * 契约：
 *
 * - **只存内容，不建索引**。标题、来源、归属、版本都属于 Blackboard 的 `artifact`
 *   记录；本缝只回答「这段内容在不在、拿出来是什么」。因此同内容 `put` 两次得到同一个
 *   `ArtifactRef`，重复发布不会产生第二份内容。
 * - **内容寻址**。`hash` 由 Provider 计算，调用方不得自报；引用是可校验的。
 * - **只增不改**。没有 `delete` 与 `update`：内容一旦落盘，语义上不再变化。
 * - **拒绝，不静默降级**。超过上限以 `ARTIFACT_INVALID` 拒绝，不去截断内容。
 *
 * 本包只承载契约与词汇，自己不注册任何服务；Provider 子类化 {@link ArtifactStore}
 * 后以插件形式挂载。
 */
export abstract class ArtifactStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'artifacts')
  }

  /**
   * 保存一段内容，返回按内容寻址的引用。
   *
   * @throws ArtifactError 内容非法或过大（`ARTIFACT_INVALID`）、存储失败（`ARTIFACT_FAILED`）。
   */
  async put(request: ArtifactPutRequest): Promise<ArtifactRef> {
    return await this.runPut(normalizePut(request))
  }

  /**
   * 取出内容。
   *
   * @throws ArtifactError 哈希不存在（`ARTIFACT_NOT_FOUND`）、读取失败（`ARTIFACT_FAILED`）。
   */
  async get(hash: string): Promise<Uint8Array> {
    assertHash(hash)
    return await this.runGet(hash)
  }

  /** 只查引用不读内容；不存在时返回 `undefined`。 */
  async stat(hash: string): Promise<ArtifactRef | undefined> {
    assertHash(hash)
    return await this.runStat(hash)
  }

  protected abstract runPut(request: Required<ArtifactPutRequest>): Promise<ArtifactRef>

  protected abstract runGet(hash: string): Promise<Uint8Array>

  protected abstract runStat(hash: string): Promise<ArtifactRef | undefined>
}

export default ArtifactStore
