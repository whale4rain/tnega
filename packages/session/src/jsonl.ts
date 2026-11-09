import { randomUUID } from 'node:crypto'
import { appendFile, copyFile, mkdir, open, readFile, rename, rm, truncate } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { isSessionEvent, type SessionBackend, type SessionLoad } from './backend.js'
import type { SessionEvent } from './index.js'
import { holdSessionLock, releaseSessionLock, sessionLockHolder } from './lock.js'

interface SessionLineScan {
  events: SessionEvent[]
  /** Byte offset just past the last valid record (and its newline, if any). */
  validEnd: number
  /** Byte offset of the first unreadable record, if any. */
  tornAt?: number
  /** A valid record follows the first unreadable one: damage, not a torn tail. */
  validAfterTorn: boolean
}

function scanSessionLines(buffer: Buffer): SessionLineScan {
  const events: SessionEvent[] = []
  let validEnd = 0
  let tornAt: number | undefined
  let validAfterTorn = false
  let offset = 0
  while (offset < buffer.length) {
    const newline = buffer.indexOf(0x0a, offset)
    const lineEnd = newline < 0 ? buffer.length : newline
    const next = newline < 0 ? buffer.length : newline + 1
    const line = buffer.subarray(offset, lineEnd).toString('utf8')
    if (line.trim()) {
      const event = parseSessionLine(line)
      if (tornAt !== undefined) {
        if (event) validAfterTorn = true
      } else if (event) {
        events.push(event)
        validEnd = next
      } else {
        tornAt = offset
      }
    } else if (tornAt === undefined) {
      validEnd = next
    }
    offset = next
  }
  return { events, validEnd, ...(tornAt !== undefined ? { tornAt } : {}), validAfterTorn }
}

function parseSessionLine(line: string): SessionEvent | undefined {
  try {
    const parsed: unknown = JSON.parse(line)
    return isSessionEvent(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

async function syncFile(file: string): Promise<void> {
  const handle = await open(file, 'r+')
  try {
    await handle.datasync()
  } finally {
    await handle.close()
  }
}

async function appendDurably(file: string, text: string): Promise<void> {
  const handle = await open(file, 'a')
  try {
    if (text) await handle.appendFile(text, 'utf8')
    await handle.datasync()
  } finally {
    await handle.close()
  }
}

async function writeFileDurably(file: string, text: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporary, 'w')
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await renameOver(temporary, file)
  } catch (error) {
    // A temporary left behind would be seen by the next reader too.
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
  await syncDirectory(dirname(file))
}

/**
 * Make a rename in `directory` durable. Windows cannot open a folder for
 * syncing and some file systems refuse it; those skip. A real I/O error
 * means the new file may not survive a power loss, so it is reported.
 */
async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return
  let handle
  try {
    handle = await open(directory, 'r')
  } catch (error) {
    if (unsupportedSync(error)) return
    throw error
  }
  try {
    await handle.sync()
  } catch (error) {
    if (!unsupportedSync(error)) throw error
  } finally {
    await handle.close()
  }
}

function unsupportedSync(error: unknown): boolean {
  const code = error instanceof Error && 'code' in error ? error.code : undefined
  return code === 'EINVAL' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'EISDIR' || code === 'EPERM' || code === 'EACCES'
}

/**
 * Windows briefly holds a just-written file (an indexer or antivirus has it
 * locked, and the rename then fails with EPERM/EBUSY/EACCES rather than waiting.
 */
async function renameOver(temporary: string, file: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temporary, file)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if ((code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') || attempt >= 9) throw error
      await new Promise(done => setTimeout(done, 20 * (attempt + 1)))
    }
  }
}

/**
 * A Session log as one JSONL file, one event per line, with a lock file next
 * to it while this process writes. Appends are plain file appends; `sync`
 * is the durability barrier. Repair cuts an unreadable tail at the last valid
 * line (keeping a copy when valid records follow the damage) and appends the
 * closers after it.
 */
export class JsonlSessionBackend implements SessionBackend {
  readonly key: string
  private scan: (SessionLineScan & { missingNewline: boolean }) | undefined

  constructor(readonly file: string) {
    this.key = resolve(file)
  }

  async load(): Promise<SessionLoad | undefined> {
    let buffer: Buffer
    try {
      buffer = await readFile(this.file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    if (!buffer.toString('utf8').trim()) return undefined
    const scan = scanSessionLines(buffer)
    const missingNewline = scan.validEnd > 0 && buffer[scan.validEnd - 1] !== 0x0a
    this.scan = { ...scan, missingNewline }
    return { events: scan.events, damaged: scan.tornAt !== undefined || missingNewline }
  }

  async heldElsewhere(): Promise<boolean> {
    return (await sessionLockHolder(this.key)) !== undefined
  }

  hold(owner: object): Promise<void> {
    return holdSessionLock(this.key, owner)
  }

  release(owner: object): Promise<void> {
    return releaseSessionLock(this.key, owner)
  }

  async create(first: SessionEvent): Promise<void> {
    await mkdir(dirname(this.key), { recursive: true })
    await writeFileDurably(this.file, `${JSON.stringify(first)}\n`)
  }

  async append(events: readonly SessionEvent[]): Promise<void> {
    if (!events.length) return
    await appendFile(this.file, `${events.map(event => JSON.stringify(event)).join('\n')}\n`, 'utf8')
  }

  sync(): Promise<void> {
    return syncFile(this.file)
  }

  async repair(closers: readonly SessionEvent[]): Promise<void> {
    const scan = this.scan
    if (scan?.tornAt !== undefined) {
      if (scan.validAfterTorn) {
        // Valid records after an unreadable line mean the file was damaged in
        // the middle, not torn at the tail. Keep the original beside it.
        await copyFile(this.file, `${this.file}.corrupt-${Date.now()}`)
      }
      await truncate(this.file, scan.validEnd)
    }
    await appendDurably(
      this.file,
      `${scan?.missingNewline ? '\n' : ''}${closers.map(event => `${JSON.stringify(event)}\n`).join('')}`,
    )
    this.scan = undefined
  }
}
