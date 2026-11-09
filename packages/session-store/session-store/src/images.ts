import type { BlobStore } from '@tnega/blobs'
import type { ImageAttachment, ModelMessage, SessionBackend, SessionEvent, SessionLoad } from '@tnega/session'

/** The format a log was created with: the last `formatVersion` its `meta` events name. */
export function sessionFormatOf(events: readonly SessionEvent[]): number | undefined {
  let version: number | undefined
  for (const event of events) {
    if (event.type !== 'meta') continue
    const value = event.payload.formatVersion
    if (typeof value === 'number') version = value
  }
  return version
}

/** The first format whose logs may keep image bytes in the blob store. */
const BLOB_IMAGES_FORMAT = 11

async function mapAll(
  images: readonly ImageAttachment[],
  map: (image: ImageAttachment) => Promise<ImageAttachment>,
): Promise<ImageAttachment[]> {
  const out: ImageAttachment[] = []
  for (const image of images) out.push(await map(image))
  return out
}

/** Every image a log keeps: on user messages, tool results and a compaction checkpoint's kept messages. */
async function mapImages(
  events: readonly SessionEvent[],
  map: (image: ImageAttachment) => Promise<ImageAttachment>,
): Promise<SessionEvent[]> {
  const out: SessionEvent[] = []
  for (const event of events) {
    if (event.type === 'user/message' && event.payload.attachments?.length) {
      out.push({ ...event, payload: { ...event.payload, attachments: await mapAll(event.payload.attachments, map) } })
    } else if (event.type === 'tool/result' && event.payload.attachments?.length) {
      out.push({ ...event, payload: { ...event.payload, attachments: await mapAll(event.payload.attachments, map) } })
    } else if (event.type === 'checkpoint' && event.payload.messages.some(message => message.attachments?.length)) {
      const messages: ModelMessage[] = []
      for (const message of event.payload.messages) {
        messages.push(message.attachments?.length ? { ...message, attachments: await mapAll(message.attachments, map) } : message)
      }
      out.push({ ...event, payload: { ...event.payload, messages } })
    } else {
      out.push(event)
    }
  }
  return out
}

/**
 * Restored images by hash, newest kept, up to a byte budget. Blobs never
 * change, so an entry is never stale; it only saves reading the same
 * screenshot again for every view of a long Session.
 */
export class ImageCache {
  private readonly entries = new Map<string, Promise<string>>()
  private readonly sizes = new Map<string, number>()
  private bytes = 0

  constructor(private readonly budget = 64 * 1024 * 1024) {}

  /** The image's base64, read from `blobs` unless it is cached. A failed read is not kept. */
  data(hash: string, blobs: BlobStore): Promise<string> {
    const cached = this.entries.get(hash)
    if (cached) {
      // Most recently used goes last, so eviction takes the oldest.
      this.entries.delete(hash)
      this.entries.set(hash, cached)
      return cached
    }
    const data = blobs.get(hash).then(stored => {
      if (!stored) throw new Error(`image blob ${hash} is missing from the blob store`)
      return Buffer.from(stored.bytes).toString('base64')
    })
    this.entries.set(hash, data)
    data.then(
      text => this.account(hash, data, text.length),
      () => { if (this.entries.get(hash) === data) this.entries.delete(hash) },
    )
    return data
  }

  private account(hash: string, data: Promise<string>, size: number): void {
    if (this.entries.get(hash) !== data) return
    this.sizes.set(hash, size)
    this.bytes += size
    for (const oldest of this.entries.keys()) {
      if (this.bytes <= this.budget || oldest === hash) break
      this.entries.delete(oldest)
      this.bytes -= this.sizes.get(oldest) ?? 0
      this.sizes.delete(oldest)
    }
  }
}

/**
 * The events as storage keeps them in a format-11 log: each image's bytes go
 * to `blobs` and the event keeps their hash. The given events are not changed.
 */
export function storeImages(events: readonly SessionEvent[], blobs: BlobStore): Promise<SessionEvent[]> {
  return mapImages(events, async image => {
    if (image.blob !== undefined) return image
    const info = await blobs.put(Buffer.from(image.data, 'base64'), image.mediaType)
    return { ...image, data: '', blob: info.hash }
  })
}

/**
 * The events as a reader sees them: every image stored in `blobs` has its
 * bytes back inline. A blob the store no longer holds is an error, never a
 * silently missing image, so a replay cannot differ from the live run.
 */
export function restoreImages(
  events: readonly SessionEvent[],
  blobs: BlobStore,
  /** Shared between calls that restore the same images. */
  cache = new ImageCache(),
): Promise<SessionEvent[]> {
  return mapImages(events, async image => {
    if (image.blob === undefined) return image
    const restored: ImageAttachment = { type: image.type, mediaType: image.mediaType, data: await cache.data(image.blob, blobs) }
    if (image.name !== undefined) restored.name = image.name
    return restored
  })
}

/** Whether a log may keep its images in the blob store. Older formats keep them inline. */
export function keepsImagesAsBlobs(events: readonly SessionEvent[]): boolean {
  return (sessionFormatOf(events) ?? 0) >= BLOB_IMAGES_FORMAT
}

/**
 * A backend that keeps image bytes in `ctx.blobs` instead of the log, for logs
 * created in format 11 or later. `SessionLog` above it sees images inline, as
 * it wrote them; a format-10 log is passed through unchanged.
 */
export class BlobImagesBackend implements SessionBackend {
  /** Whether this log keeps images as blobs; known once it is loaded or created. */
  private blobImages = false

  constructor(
    private readonly inner: SessionBackend,
    private readonly blobs: BlobStore,
    private readonly cache = new ImageCache(),
  ) {}

  get key(): string {
    return this.inner.key
  }

  async load(): Promise<SessionLoad | undefined> {
    const loaded = await this.inner.load()
    if (!loaded) return undefined
    this.blobImages = keepsImagesAsBlobs(loaded.events)
    return { ...loaded, events: await restoreImages(loaded.events, this.blobs, this.cache) }
  }

  heldElsewhere(): Promise<boolean> {
    return this.inner.heldElsewhere()
  }

  hold(owner: object): Promise<void> {
    return this.inner.hold(owner)
  }

  release(owner: object): Promise<void> {
    return this.inner.release(owner)
  }

  async create(first: SessionEvent): Promise<void> {
    this.blobImages = keepsImagesAsBlobs([first])
    await this.inner.create((await this.stored([first]))[0] ?? first)
  }

  async append(events: readonly SessionEvent[]): Promise<void> {
    await this.inner.append(await this.stored(events))
  }

  sync(): Promise<void> {
    return this.inner.sync()
  }

  async repair(closers: readonly SessionEvent[]): Promise<void> {
    await this.inner.repair(await this.stored(closers))
  }

  private stored(events: readonly SessionEvent[]): Promise<SessionEvent[]> {
    return this.blobImages ? storeImages(events, this.blobs) : Promise.resolve([...events])
  }
}
