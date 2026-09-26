import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { Context } from '@tnega/core'
import {
  ArtifactError,
  ArtifactStore,
  MAX_ARTIFACT_BYTES,
  type ArtifactPutRequest,
  type ArtifactRef,
} from '@tnega/artifact-store'

export interface LocalArtifactConfig {
  /**
   * 产物目录。组合层决定它在 Project 目录下的位置（约定为
   * `<project>/.tnega/projects/<projectId>/artifacts`）。
   */
  root: string
  /** 单份内容上限，默认 {@link MAX_ARTIFACT_BYTES}。 */
  maxBytes?: number
}

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? new TextEncoder().encode(content) : content
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 本地产物 Provider：内容寻址的文件树。
 *
 * ```
 * <root>/<hash 前两位>/<hash>            # 内容
 * <root>/<hash 前两位>/<hash>.meta.json  # { size, mediaType }
 * ```
 *
 * 两级目录只是为了让一个目录别堆上万个文件，`<hash 前两位>` 不参与寻址语义。
 *
 * 取舍：
 *
 * - **写一次，不改**。内容按哈希落盘后不再变化；`mediaType` 是内容附带的第一份声明，
 *   同内容再 `put` 一次不会改掉它 —— 引用必须稳定，否则同一个哈希会解释出两种类型。
 * - **先写临时文件再改名**。崩在写入中间只会留下一个 `.tmp`，读者永远看不到半份内容。
 */
export class LocalArtifactStore extends ArtifactStore {
  private readonly root: string
  private readonly maxBytes: number

  constructor(ctx: Context, config: LocalArtifactConfig) {
    super(ctx)
    if (!config?.root || typeof config.root !== 'string') {
      throw new ArtifactError('artifact-local requires a root directory', 'ARTIFACT_INVALID')
    }
    const maxBytes = config.maxBytes ?? MAX_ARTIFACT_BYTES
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new ArtifactError('maxBytes must be a positive integer', 'ARTIFACT_INVALID')
    }
    this.root = resolve(config.root)
    this.maxBytes = maxBytes
  }

  protected override async runPut(request: Required<ArtifactPutRequest>): Promise<ArtifactRef> {
    const bytes = toBytes(request.content)
    if (!bytes.byteLength) {
      throw new ArtifactError('artifact content must not be empty', 'ARTIFACT_INVALID')
    }
    if (bytes.byteLength > this.maxBytes) {
      throw new ArtifactError(
        `artifact content exceeds ${this.maxBytes} bytes`,
        'ARTIFACT_INVALID',
      )
    }
    const hash = createHash('sha256').update(bytes).digest('hex')
    const existing = await this.runStat(hash)
    if (existing) return existing
    const file = join(this.contentDir(hash), hash)
    await mkdir(dirname(file), { recursive: true })
    await this.writeAtomic(file, bytes)
    await this.writeAtomic(
      `${file}.meta.json`,
      new TextEncoder().encode(JSON.stringify({
        size: bytes.byteLength,
        mediaType: request.mediaType,
      })),
    )
    return { hash, size: bytes.byteLength, mediaType: request.mediaType }
  }

  protected override async runGet(hash: string): Promise<Uint8Array> {
    try {
      return await readFile(join(this.contentDir(hash), hash))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ArtifactError(`artifact not found: ${hash}`, 'ARTIFACT_NOT_FOUND')
      }
      throw new ArtifactError(`could not read artifact ${hash}`, 'ARTIFACT_FAILED', { cause: error })
    }
  }

  protected override async runStat(hash: string): Promise<ArtifactRef | undefined> {
    const file = join(this.contentDir(hash), hash)
    let meta: string
    try {
      meta = await readFile(`${file}.meta.json`, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new ArtifactError(`could not read artifact ${hash}`, 'ARTIFACT_FAILED', { cause: error })
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(meta)
    } catch (error) {
      throw new ArtifactError(
        `artifact metadata is not valid JSON: ${hash}`,
        'ARTIFACT_FAILED',
        { cause: error },
      )
    }
    if (!isRecord(parsed) || typeof parsed.size !== 'number' || typeof parsed.mediaType !== 'string') {
      throw new ArtifactError(`artifact metadata is malformed: ${hash}`, 'ARTIFACT_FAILED')
    }
    return { hash, size: parsed.size, mediaType: parsed.mediaType }
  }

  private contentDir(hash: string): string {
    return join(this.root, hash.slice(0, 2))
  }

  /**
   * 同目录内的改名是原子的；崩在中间只会留下 `.tmp`，读者看不到半份内容。并发写入同一
   * 哈希时两个临时文件内容相同，后者覆盖前者不影响结果。
   */
  private async writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, bytes, { flag: 'wx' })
      await rename(temp, path)
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {})
      throw new ArtifactError(`could not write artifact ${path}`, 'ARTIFACT_FAILED', { cause: error })
    }
  }
}

export const artifactLocal = {
  name: 'artifact-local',
  apply(ctx: Context, config: LocalArtifactConfig): void {
    new LocalArtifactStore(ctx, config)
  },
}
