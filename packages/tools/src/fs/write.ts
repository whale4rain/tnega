import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ToolDefinition, ToolExecuteOptions } from '../index.js'
import { ToolInputError } from '../errors.js'
import { optionalBoolean, record, stringField } from '../input.js'
import { exists, writeFileAtomic } from './atomic.js'
import { checkObserved, type CurrentVersion } from './guards.js'
import { withPathLock } from './lock.js'
import { fingerprint, recordObservation } from './observed.js'
import type { FileToolsConfig } from './types.js'

export function writeFileTool(config: FileToolsConfig): ToolDefinition {
  return {
    schema: {
      name: 'write_file',
      description: [
        'Write UTF-8 text to a file inside the workspace, creating parent directories as needed.',
        'The file is replaced atomically: a reader sees the old content or the new one, never a partial write.',
        'Overwriting a file that was read in this session is checked against that version; pass append to add instead of replace.',
        'Returns { path, bytes, appended, sha256 }.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'file path relative to the workspace' },
          content: { type: 'string', description: 'text content to write' },
          append: { type: 'boolean', description: 'append instead of overwrite' },
        },
        required: ['path', 'content'],
      },
    },
    interruption: 'confirm',
    async execute(input, options: ToolExecuteOptions) {
      const args = record(input)
      const target = await config.resolve(stringField(args.path, 'path'))
      const content = stringField(args.content, 'content')
      const append = optionalBoolean(args.append, 'append') ?? false
      const bytes = Buffer.byteLength(content, 'utf8')
      if (bytes > config.maxWriteBytes) {
        throw new ToolInputError(`content exceeds ${config.maxWriteBytes} bytes`)
      }
      const display = config.displayPath(target)
      const signal = options.signal ? { signal: options.signal } : {}
      return await withPathLock(target, async () => {
        const current: CurrentVersion = await exists(target)
          ? { kind: 'present', sha256: fingerprint(await readFile(target)) }
          : { kind: 'absent' }
        if (append) {
          if (current.kind === 'present') {
            await appendFile(target, content, { encoding: 'utf8', ...signal })
          } else {
            // Appending to a missing file creates it; a concurrent creator
            // surfaces as a conflict instead of being silently extended.
            await mkdir(dirname(target), { recursive: true })
            await writeFileAtomic(target, content, { createOnly: true, ...signal })
          }
          const after = await readFile(target)
          const sha256 = fingerprint(after)
          recordObservation(options.agentId, target, { kind: 'present', sha256 })
          return { path: display, bytes, appended: true, sha256 }
        }
        const verdict = checkObserved(config, options.agentId, target, display, current)
        await writeFileAtomic(target, content, { createOnly: current.kind === 'absent', ...signal })
        const sha256 = fingerprint(content)
        recordObservation(options.agentId, target, { kind: 'present', sha256 })
        return {
          path: display,
          bytes,
          appended: false,
          sha256,
          ...(verdict.warning ? { warning: verdict.warning } : {}),
        }
      })
    },
  }
}
