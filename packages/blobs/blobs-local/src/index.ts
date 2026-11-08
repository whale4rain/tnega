import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@tnega/core'
import { BlobError, BlobStore, blobHash, isBlobHash, type Blob, type BlobInfo } from '@tnega/blobs'
import { resolveTnegaHome } from '@tnega/home'

export interface Config {
  /** Where blobs live; default `~/.tnega/blobs` (or under `TNEGA_HOME`). */
  root?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Write through a temporary file and a rename, so a reader sees all of a file or none of it. */
async function writeOnce(file: string, data: Uint8Array | string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, data)
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * `ctx.blobs` on this machine: `<root>/<aa>/<hash>` holds the bytes and
 * `<hash>.json` their size and media type, `aa` being the hash's first two
 * characters so no folder grows too large.
 */
export class LocalBlobStore extends BlobStore {
  readonly root: string

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.root = config.root ?? join(resolveTnegaHome(), 'blobs')
  }

  private file(hash: string): string {
    return join(this.root, hash.slice(0, 2), hash)
  }

  async put(bytes: Uint8Array, mediaType: string): Promise<BlobInfo> {
    if (!(bytes instanceof Uint8Array)) throw new BlobError('BLOB_INVALID', 'a blob is bytes')
    if (typeof mediaType !== 'string' || !mediaType.trim()) throw new BlobError('BLOB_INVALID', 'a blob needs a media type')
    const hash = blobHash(bytes)
    const info: BlobInfo = { hash, size: bytes.byteLength, mediaType }
    if (await this.has(hash)) return info
    const file = this.file(hash)
    try {
      await mkdir(join(this.root, hash.slice(0, 2)), { recursive: true })
      // The description first: a blob is only there once its bytes are.
      await writeOnce(`${file}.json`, JSON.stringify({ size: info.size, mediaType }))
      await writeOnce(file, bytes)
    } catch (error) {
      throw new BlobError('BLOB_FAILED', `could not store blob ${hash}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    return info
  }

  async get(hash: string): Promise<Blob | undefined> {
    if (!isBlobHash(hash)) throw new BlobError('BLOB_INVALID', `not a blob hash: ${hash}`)
    const file = this.file(hash)
    let bytes: Uint8Array
    let described: unknown
    try {
      bytes = new Uint8Array(await readFile(file))
      described = JSON.parse(await readFile(`${file}.json`, 'utf8'))
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw new BlobError('BLOB_FAILED', `could not read blob ${hash}`, { cause: error })
    }
    if (blobHash(bytes) !== hash) throw new BlobError('BLOB_FAILED', `blob ${hash} is damaged: its bytes no longer match its hash`)
    const mediaType = isRecord(described) && typeof described.mediaType === 'string' ? described.mediaType : 'application/octet-stream'
    return { hash, size: bytes.byteLength, mediaType, bytes }
  }

  async has(hash: string): Promise<boolean> {
    if (!isBlobHash(hash)) return false
    return (await stat(this.file(hash)).catch(() => undefined))?.isFile() === true
  }
}

/** Mount: `await ctx.plugin(blobsLocal, { root? })`. */
export const blobsLocal = {
  name: 'blobs-local',
  apply(ctx: Context, config: Config = {}): void {
    new LocalBlobStore(ctx, config)
  },
}

export const name = '@tnega/blobs-local'
