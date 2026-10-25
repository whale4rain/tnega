import { open, readFile, stat } from 'node:fs/promises'
import type { ToolDefinition, ToolExecuteOptions } from '../index.js'
import { ToolInputError } from '../errors.js'
import { optionalNumber, record, stringField } from '../input.js'
import { fingerprint, recordObservation } from './observed.js'
import { READ_WHOLE_FILE_LIMIT, type FileToolsConfig } from './types.js'

/**
 * Drop a trailing byte prefix that ends mid-UTF-8-sequence, so decoding a
 * truncated read never leaves a replacement character at the cut.
 */
export function trimPartialUtf8(buffer: Buffer): Buffer {
  for (let back = 1; back <= 3 && back <= buffer.length; back += 1) {
    const byte = buffer[buffer.length - back]!
    if ((byte & 0x80) === 0) return buffer
    if ((byte & 0xc0) === 0xc0) {
      const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2
      return back === needed ? buffer : buffer.subarray(0, buffer.length - back)
    }
  }
  return buffer
}

async function readPrefix(target: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(target, 'r')
  try {
    const buffer = Buffer.allocUnsafe(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** How many lines a text has, without counting a trailing newline as one. */
function countLines(text: string): number {
  if (!text) return 0
  const breaks = text.split('\n').length - 1
  return text.endsWith('\n') ? breaks : breaks + 1
}

export function readFileTool(config: FileToolsConfig): ToolDefinition {
  return {
    schema: {
      name: 'read_file',
      description: [
        'Read a UTF-8 text file inside the workspace, one page of lines at a time.',
        `Returns { path, bytes, content, truncated, lines: { start, end, total } }: \`bytes\` is the whole file size,`,
        `\`content\` is lines \`start\`..\`end\` of \`total\`, and \`truncated\` says whether anything was left out of \`content\`.`,
        `Page with offset (1-based) and limit (default and maximum ${config.maxReadLines} lines).`,
        'Reading a file records it as seen: a later write or edit of it is checked against that version.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'file path relative to the workspace' },
          offset: { type: 'number', description: 'first line to return, 1-based (default 1)' },
          limit: { type: 'number', description: `how many lines to return (default and maximum ${config.maxReadLines})` },
          maxBytes: { type: 'number', description: 'optional byte limit for the returned content' },
        },
        required: ['path'],
      },
    },
    // Read-only: a call cut off by a restart is safe to issue again.
    interruption: 'retry',
    async execute(input, options: ToolExecuteOptions) {
      const args = record(input)
      const target = await config.resolve(stringField(args.path, 'path'))
      const stats = await stat(target)
      if (stats.isDirectory()) throw new ToolInputError(`not a file: ${args.path}`)
      const offset = optionalNumber(args.offset, 'offset') ?? 1
      if (!Number.isInteger(offset) || offset < 1) throw new ToolInputError(`offset must be a positive whole number: ${offset}`)
      const requested = optionalNumber(args.limit, 'limit') ?? config.maxReadLines
      if (!Number.isInteger(requested) || requested < 1) throw new ToolInputError(`limit must be a positive whole number: ${requested}`)
      const limit = Math.min(requested, config.maxReadLines)
      const maxBytes = optionalNumber(args.maxBytes, 'maxBytes') ?? config.maxReadBytes
      if (maxBytes <= 0) throw new ToolInputError(`maxBytes must be positive: ${maxBytes}`)

      // A file past the whole-file limit is paged within the prefix that was
      // read; its hash is then incomplete, so the read does not authorize a
      // guarded overwrite.
      const whole = stats.size <= READ_WHOLE_FILE_LIMIT
      const buffer = whole ? await readFile(target) : await readPrefix(target, READ_WHOLE_FILE_LIMIT)
      if (buffer.includes(0)) throw new ToolInputError(`file is binary: ${args.path}`)
      if (whole) recordObservation(options.agentId, target, { kind: 'present', sha256: fingerprint(buffer) })

      const text = buffer.toString('utf8')
      const total = countLines(text)
      const rawLines = text.split('\n')
      const page = rawLines.slice(offset - 1, offset - 1 + limit)
      let clipped = 0
      const lines = page.map(line => {
        if (line.length <= config.maxLineChars) return line
        clipped += 1
        return line.slice(0, config.maxLineChars)
      })
      const end = page.length ? Math.min(total, offset + page.length - 1) : 0
      const joined = lines.join('\n')
      const bytes = Buffer.byteLength(joined, 'utf8')
      const content = bytes > maxBytes ? trimPartialUtf8(Buffer.from(joined, 'utf8').subarray(0, maxBytes)).toString('utf8') : joined
      const truncated = !whole || end < total || offset > 1 || clipped > 0 || content.length !== joined.length
      return {
        path: config.displayPath(target),
        bytes: stats.size,
        content,
        truncated,
        lines: { start: page.length ? offset : 0, end, total },
        ...(clipped ? { clippedLines: clipped } : {}),
      }
    },
  }
}
