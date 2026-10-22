import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@tnega/core'
import { artifactLocal } from '../src/index.js'

// Keep the real filesystem, with a replaceable `rename` for the Windows race.
vi.mock('node:fs/promises', async (importOriginal: () => Promise<typeof import('node:fs/promises')>) => ({
  ...await importOriginal(),
}))

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  // Windows 上文件可能还被后台写入占着，重试比让清理失败更诚实。
  await Promise.all(directories.splice(0).map(path => rm(path, {
    recursive: true, force: true, maxRetries: 10, retryDelay: 50,
  })))
})

async function mount(): Promise<{ ctx: Context; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'tnega-artifact-local-'))
  directories.push(root)
  const ctx = new Context()
  await ctx.plugin(artifactLocal, { root })
  return { ctx, root }
}

function eperm(): NodeJS.ErrnoException {
  return Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
}

function bytesOf(content: string): Uint8Array {
  return new TextEncoder().encode(content)
}

it('publishes identical content once when writers arrive together', async () => {
  const { ctx, root } = await mount()
  try {
    const content = 'Same bytes'
    const refs = await Promise.all(
      Array.from({ length: 16 }, () => ctx.artifacts.put({ content, mediaType: 'text/plain' })),
    )
    const hash = refs[0]!.hash
    expect(createHash('sha256').update(bytesOf(content)).digest('hex')).toBe(hash)
    expect(new Set(refs.map(ref => ref.hash))).toEqual(new Set([hash]))
    expect(Buffer.from(await ctx.artifacts.get(hash))).toEqual(Buffer.from(content))
    expect(await ctx.artifacts.stat(hash)).toEqual({ hash, size: bytesOf(content).byteLength, mediaType: 'text/plain' })
    // 只有一个内容文件、一份 metadata，且没有竞争留下的临时文件。
    expect((await readdir(join(root, hash.slice(0, 2)))).sort())
      .toEqual([hash, `${hash}.meta.json`].sort())
  } finally {
    await ctx.fiber.dispose()
  }
})

it('retries a rename another writer is briefly holding', async () => {
  const { ctx } = await mount()
  try {
    const rename = fs.rename
    let blocked = false
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!blocked) {
        blocked = true
        throw eperm()
      }
      await rename(from, to)
    })
    const ref = await ctx.artifacts.put({ content: 'retried' })
    expect(Buffer.from(await ctx.artifacts.get(ref.hash))).toEqual(Buffer.from('retried'))
  } finally {
    await ctx.fiber.dispose()
  }
})

it('accepts identical bytes another writer published first', async () => {
  const { ctx, root } = await mount()
  try {
    const content = 'published elsewhere'
    const bytes = bytesOf(content)
    const hash = createHash('sha256').update(bytes).digest('hex')
    const directory = join(root, hash.slice(0, 2))
    await mkdir(directory, { recursive: true })
    // 另一个写入者的内容已经就位，但它的 metadata 还没落盘。
    await writeFile(join(directory, hash), bytes)
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(eperm())
    const ref = await ctx.artifacts.put({ content })
    expect(ref).toEqual({ hash, size: bytes.byteLength, mediaType: 'text/plain' })
    expect(Buffer.from(await ctx.artifacts.get(hash))).toEqual(Buffer.from(bytes))
    expect(await ctx.artifacts.stat(hash)).toMatchObject({ hash, mediaType: 'text/plain' })
    expect((await readdir(directory)).some(file => file.endsWith('.tmp'))).toBe(false)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('reports the mediaType that won the metadata race', async () => {
  const { ctx } = await mount()
  try {
    const content = 'race metadata'
    const size = bytesOf(content).byteLength
    const rename = fs.rename
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('.meta.json')) {
        // 竞争者在我们的改名完成前先落下了它声明的类型。
        await writeFile(to, JSON.stringify({ size, mediaType: 'application/json' }))
        throw eperm()
      }
      await rename(from, to)
    })
    const ref = await ctx.artifacts.put({ content, mediaType: 'text/markdown' })
    expect(ref).toMatchObject({ size, mediaType: 'application/json' })
    expect(await ctx.artifacts.stat(ref.hash)).toMatchObject({ size, mediaType: 'application/json' })
  } finally {
    await ctx.fiber.dispose()
  }
})
