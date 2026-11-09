import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { blobsLocal } from '@tnega/blobs-local'
import { Context } from '@tnega/core'
import { JsonlSessionBackend, SessionLog, type ImageAttachment, type SessionEvent } from '@tnega/session'
import { sessionFile, sessionStoreJsonl } from '../src/index.js'

const dirs: string[] = []
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

async function setup(options: { blobs?: boolean } = {}) {
  const workspace = await temp('tnega-store-images-')
  const ctx = new Context()
  if (options.blobs !== false) {
    const blobs = await ctx.plugin(blobsLocal, { root: await temp('tnega-blobs-') })
    cleanups.push(() => blobs.dispose())
  }
  const mounted = await ctx.plugin(sessionStoreJsonl)
  cleanups.push(() => mounted.dispose())
  return { store: ctx.get('sessionStore'), workspace }
}

// A different image each run, so no earlier blob can answer for it.
const png: ImageAttachment = { type: 'image', mediaType: 'image/png', data: Buffer.from(`png ${randomUUID()}`).toString('base64'), name: 'shot.png' }

async function all(events: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const out: SessionEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

function imagesOf(events: readonly SessionEvent[]): ImageAttachment[] {
  return events.flatMap(event => event.type === 'user/message' || event.type === 'tool/result' ? event.payload.attachments ?? [] : [])
}

describe('images in a Session', () => {
  it('keeps image bytes in the blob store, and a replay sees what the live run saw', async () => {
    const { store, workspace } = await setup()
    const { id } = await store.create(workspace, { title: 'Images' })
    const live = new SessionLog(store.backend(workspace, id))
    await live.init()
    await live.append('user/message', { content: 'look', attachments: [png] })
    await live.append('assistant/message', { content: 'a screenshot' })
    const liveMessages = await live.deriveMessages()
    const liveEvents = await live.read()
    await live.close()

    const text = await readFile(sessionFile(workspace, id), 'utf8')
    expect(text).toContain('"formatVersion":11')
    expect(text).not.toContain(png.data)
    expect(text).toMatch(/"blob":"[0-9a-f]{64}"/u)

    const replay = new SessionLog(store.backend(workspace, id))
    await replay.init()
    expect(await replay.deriveMessages()).toEqual(liveMessages)
    expect(await replay.read()).toEqual(liveEvents)
    await replay.close()

    // Clients reading the store see the bytes too.
    expect(imagesOf(await all(store.read(workspace, id)))).toEqual([png])
    expect(imagesOf((await store.snapshot(workspace, id)).events)).toEqual([png])
  })

  it('stores images appended through the store as blobs, and a retry is still the same batch', async () => {
    const { store, workspace } = await setup()
    const { id } = await store.create(workspace, { title: 'Images' })
    await store.lease(workspace, id, 'runtime')
    const event: SessionEvent = { id: randomUUID(), seq: 2, ts: 1, type: 'user/message', payload: { content: 'look', attachments: [png] } }
    expect(await store.append(workspace, id, { expectedSeq: 1, events: [event], owner: 'runtime' })).toEqual({ status: 'committed', seqs: [2] })
    expect(await store.append(workspace, id, { expectedSeq: 1, events: [event], owner: 'runtime' })).toEqual({ status: 'committed', seqs: [2] })
    expect(await readFile(sessionFile(workspace, id), 'utf8')).not.toContain(png.data)
    expect((await all(store.read(workspace, id))).slice(1)).toEqual([event])
  })

  it('reads a format-10 log and keeps appending to it inline', async () => {
    const { store, workspace } = await setup()
    const { id } = await store.create(workspace, { title: 'Old' })
    const file = sessionFile(workspace, id)
    const old: SessionEvent[] = [
      { id: randomUUID(), seq: 1, ts: 1, type: 'meta', payload: { formatVersion: 10, title: 'Old' } },
      { id: randomUUID(), seq: 2, ts: 2, type: 'user/message', payload: { content: 'before', attachments: [png] } },
    ]
    await writeFile(file, old.map(event => `${JSON.stringify(event)}\n`).join(''))

    const log = new SessionLog(store.backend(workspace, id))
    await log.init()
    expect(await log.read()).toEqual(old)
    await log.append('user/message', { content: 'after', attachments: [png] })
    await log.close()

    const text = await readFile(file, 'utf8')
    expect(text).not.toContain('"blob"')
    expect(text.split(png.data).length - 1).toBe(2)
    expect(imagesOf(await all(store.read(workspace, id)))).toEqual([png, png])
  })

  it('shows only the hash to a reader that opens the bare file, never a wrong image', async () => {
    const { store, workspace } = await setup()
    const { id } = await store.create(workspace, { title: 'Images' })
    const log = new SessionLog(store.backend(workspace, id))
    await log.init()
    await log.append('user/message', { content: 'look', attachments: [png] })
    await log.close()

    const bare = SessionLog.readOnly(new JsonlSessionBackend(sessionFile(workspace, id)))
    const [image] = imagesOf(await bare.read())
    expect(image).toMatchObject({ data: '', blob: expect.stringMatching(/^[0-9a-f]{64}$/u) })
  })

  it('keeps images inline when the machine has no blob store', async () => {
    const { store, workspace } = await setup({ blobs: false })
    const { id } = await store.create(workspace, { title: 'Inline' })
    const log = new SessionLog(store.backend(workspace, id))
    await log.init()
    await log.append('user/message', { content: 'look', attachments: [png] })
    await log.close()
    expect(await readFile(sessionFile(workspace, id), 'utf8')).toContain(png.data)
  })
})
