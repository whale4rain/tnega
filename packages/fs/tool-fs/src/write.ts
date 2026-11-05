import {
  optionalBoolean, record, stringField,
  ToolInputError,
  withPathLock,
  type ToolDefinition,
  type ToolExecuteOptions,
} from '@tnega/tools'
import { readCurrent, writeThrough } from './files.js'
import { checkObserved, type CurrentVersion } from './guards.js'
import { fingerprint } from './observed.js'
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
        const before = await readCurrent(config.fs, target)
        const current: CurrentVersion = before ? { kind: 'present', sha256: fingerprint(before) } : { kind: 'absent' }
        if (append) {
          // Appending to a missing file creates it; a concurrent creator
          // surfaces as a conflict instead of being silently extended.
          await writeThrough(config.fs, target, content, { mode: current.kind === 'present' ? 'append' : 'create', ...signal })
          // The new version is what was there plus what we added; no read after the write,
          // which could fail on a large remote file after the append has landed.
          const sha256 = fingerprint(before ? Buffer.concat([before, Buffer.from(content, 'utf8')]) : content)
          config.observations.record(options.agentId, target, { kind: 'present', sha256 })
          return { path: display, bytes, appended: true, sha256 }
        }
        const verdict = checkObserved(config, options.agentId, target, display, current)
        await writeThrough(config.fs, target, content, { mode: current.kind === 'absent' ? 'create' : 'replace', ...signal })
        const sha256 = fingerprint(content)
        config.observations.record(options.agentId, target, { kind: 'present', sha256 })
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
