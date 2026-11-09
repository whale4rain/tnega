import { createHash } from 'node:crypto'
import { Service, type Context } from '@tnega/core'

declare module '@tnega/core' {
  interface ServiceMap {
    blobs: BlobStore
  }
}

export type BlobErrorCode =
  /** The request itself is wrong: not bytes, not a hash, no media type. */
  | 'BLOB_INVALID'
  /** Storage failed, or what it holds no longer matches its hash. */
  | 'BLOB_FAILED'

export class BlobError extends Error {
  constructor(readonly code: BlobErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'BlobError'
  }
}

/** A stored blob: its content hash, size in bytes and media type. */
export interface BlobInfo {
  hash: string
  size: number
  mediaType: string
}

export interface Blob extends BlobInfo {
  bytes: Uint8Array
}

const HASH = /^[0-9a-f]{64}$/u

/** The name a blob is stored under: the SHA-256 of its bytes, in lowercase hex. */
export function blobHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function isBlobHash(value: unknown): value is string {
  return typeof value === 'string' && HASH.test(value)
}

/**
 * Service Definition of the blob store: bytes too big to keep inside a
 * Session event (images, large tool output) stored once by content hash.
 * Owns `ctx.blobs`; the local Provider keeps files under `~/.tnega/blobs`, a
 * server a directory or object storage.
 *
 * Contract:
 *
 * - **Content addressed.** `put` names a blob by {@link blobHash}; putting
 *   the same bytes again stores nothing new and answers the same hash.
 * - **Immutable.** A stored blob never changes. `get` checks the bytes still
 *   match their hash and fails with `BLOB_FAILED` when they do not.
 * - **Missing is not an error.** `get` answers `undefined` and `has` `false`
 *   for a hash the store does not hold.
 */
export abstract class BlobStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'blobs')
  }

  abstract put(bytes: Uint8Array, mediaType: string): Promise<BlobInfo>
  abstract get(hash: string): Promise<Blob | undefined>
  abstract has(hash: string): Promise<boolean>
}

export const name = '@tnega/blobs'
