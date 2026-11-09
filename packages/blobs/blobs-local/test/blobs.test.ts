import { mkdtemp, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { BlobError, blobHash } from '@tnega/blobs'
import { blobsLocal } from '../src/index.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function mount() {
  const root = await mkdtemp(join(tmpdir(), 'tnega-blobs-'))
  dirs.push(root)
  const ctx = new Context()
  await ctx.plugin(blobsLocal, { root })
  return { blobs: ctx.get('blobs'), root }
}

const bytes = new TextEncoder().encode('a picture, honestly')

it('stores bytes by their hash and gives them back', async () => {
  const { blobs } = await mount()
  const info = await blobs.put(bytes, 'image/png')
  expect(info).toEqual({ hash: blobHash(bytes), size: bytes.byteLength, mediaType: 'image/png' })
  expect(info.hash).toMatch(/^[0-9a-f]{64}$/u)
  expect(await blobs.has(info.hash)).toBe(true)
  const blob = await blobs.get(info.hash)
  expect(blob?.mediaType).toBe('image/png')
  expect(Buffer.from(blob?.bytes ?? []).toString()).toBe('a picture, honestly')
})

it('stores the same bytes once', async () => {
  const { blobs, root } = await mount()
  const first = await blobs.put(bytes, 'image/png')
  const again = await blobs.put(bytes, 'image/png')
  expect(again.hash).toBe(first.hash)
  expect(await readdir(join(root, first.hash.slice(0, 2)))).toEqual([first.hash, `${first.hash}.json`])
})

it('answers a missing blob with nothing, and a damaged one with an error', async () => {
  const { blobs, root } = await mount()
  const missing = blobHash(new TextEncoder().encode('never stored'))
  expect(await blobs.has(missing)).toBe(false)
  expect(await blobs.get(missing)).toBeUndefined()

  const info = await blobs.put(bytes, 'image/png')
  await writeFile(join(root, info.hash.slice(0, 2), info.hash), 'tampered')
  await expect(blobs.get(info.hash)).rejects.toMatchObject({ code: 'BLOB_FAILED' })
})

it('still gives back a blob whose description was lost', async () => {
  const { blobs, root } = await mount()
  const info = await blobs.put(bytes, 'image/png')
  await unlink(join(root, info.hash.slice(0, 2), `${info.hash}.json`))
  expect(await blobs.has(info.hash)).toBe(true)
  expect(await blobs.get(info.hash)).toMatchObject({ hash: info.hash, mediaType: 'application/octet-stream' })
})

it('refuses what is not a blob or a hash', async () => {
  const { blobs } = await mount()
  await expect(blobs.put(bytes, '')).rejects.toBeInstanceOf(BlobError)
  await expect(blobs.get('../../etc/passwd')).rejects.toMatchObject({ code: 'BLOB_INVALID' })
  expect(await blobs.has('../../etc/passwd')).toBe(false)
})
