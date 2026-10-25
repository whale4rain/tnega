import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { FileServeError, MAX_UPLOAD_BYTES, isRuntimeFile, safeUploadName, saveUpload } from '../src/index.js'

const dirs: string[] = []

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-uploads-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('dropped files', () => {
  it('saves the bytes under .tnega/uploads and never overwrites an earlier drop', async () => {
    const dir = await workspace()
    const first = await saveUpload(dir, 'notes.md', Buffer.from('# one\n'))
    const second = await saveUpload(dir, 'notes.md', Buffer.from('# two\n'))
    expect(first).toEqual({ path: '.tnega/uploads/notes.md', size: 6 })
    expect(second.path).toBe('.tnega/uploads/notes (2).md')
    expect(await readFile(join(dir, '.tnega', 'uploads', 'notes.md'), 'utf8')).toBe('# one\n')
    expect(await readFile(join(dir, '.tnega', 'uploads', 'notes (2).md'), 'utf8')).toBe('# two\n')
    // A dropped file is not an edit to the project, so the Changes list leaves it out.
    expect(isRuntimeFile(first.path)).toBe(true)
  })

  it('keeps a name from reaching outside the uploads folder or tripping Windows', () => {
    expect(safeUploadName('../../etc/passwd')).toBe('passwd')
    expect(safeUploadName('C:\\Users\\me\\report.docx')).toBe('report.docx')
    expect(safeUploadName('a<b>:c?.txt')).toBe('a_b__c_.txt')
    expect(safeUploadName('..')).toBe('file')
    expect(safeUploadName('.env')).toBe('env')
    const long = safeUploadName(`${'x'.repeat(300)}.docx`)
    expect(long.length).toBeLessThanOrEqual(120)
    expect(long.endsWith('.docx')).toBe(true)
  })

  it('refuses a file over the size limit', async () => {
    const dir = await workspace()
    const error = await saveUpload(dir, 'big.bin', new Uint8Array(MAX_UPLOAD_BYTES + 1)).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(FileServeError)
    expect(error).toMatchObject({ status: 413 })
  })
})
