import { readFile } from 'node:fs/promises'
import {
  record, stringField,
  ToolInputError,
  withPathLock,
  type ToolDefinition,
  type ToolExecuteOptions,
} from '@tnega/tools'
import { exists, writeFileAtomic } from './atomic.js'
import { checkObserved, type CurrentVersion } from './guards.js'
import { fingerprint } from './observed.js'
import type { FileToolsConfig } from './types.js'

interface Edit {
  oldText: string
  newText: string
  replaceAll: boolean
}

interface Placement {
  edit: Edit
  start: number
  end: number
  /** 1-based line the match starts on. */
  line: number
}

function lineAt(content: string, offset: number): number {
  let line = 1
  for (let index = 0; index < offset; index += 1) {
    if (content[index] === '\n') line += 1
  }
  return line
}

function occurrences(content: string, search: string): number[] {
  const found: number[] = []
  let from = 0
  while (true) {
    const at = content.indexOf(search, from)
    if (at < 0) return found
    found.push(at)
    from = at + search.length
  }
}

function parseEdits(value: unknown): Edit[] {
  if (!Array.isArray(value) || !value.length) {
    throw new ToolInputError('edits must be a non-empty array of { old_string, new_string }')
  }
  return value.map((entry, index) => {
    const edit = record(entry, `edits[${index}]`)
    const oldText = stringField(edit.old_string, `edits[${index}].old_string`)
    if (!oldText) throw new ToolInputError(`edits[${index}].old_string must not be empty`)
    const newText = stringField(edit.new_string, `edits[${index}].new_string`)
    const replaceAll = edit.replace_all === undefined ? false : edit.replace_all === true
    return { oldText, newText, replaceAll }
  })
}

/**
 * Locate every edit in the current content: each must appear exactly once,
 * unless it says `replace_all`. Ambiguity is reported with the lines it matched
 * so the model can add context instead of guessing.
 */
function placeEdits(content: string, edits: readonly Edit[], display: string): Placement[] {
  const placements: Placement[] = []
  for (const edit of edits) {
    const found = occurrences(content, edit.oldText)
    if (!found.length) {
      throw new ToolInputError(
        `no replacement was performed: old_string did not appear verbatim in ${display}. Copy the exact text, including whitespace, or use write_file to replace the whole file.`,
      )
    }
    if (!edit.replaceAll && found.length > 1) {
      const lines = found.map(offset => lineAt(content, offset)).join(', ')
      throw new ToolInputError(
        `no replacement was performed: old_string appears ${found.length} times in ${display} (lines ${lines}). Include enough surrounding text to make it unique, or pass replace_all.`,
      )
    }
    for (const start of found) {
      placements.push({ edit, start, end: start + edit.oldText.length, line: lineAt(content, start) })
    }
  }
  const sorted = [...placements].sort((left, right) => left.start - right.start)
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]!
    const current = sorted[index]!
    if (current.start < previous.end) {
      throw new ToolInputError(
        `no replacement was performed: the edits overlap in ${display} (lines ${previous.line} and ${current.line}). Make them independent.`,
      )
    }
  }
  return sorted
}

function applyPlacements(content: string, placements: readonly Placement[]): string {
  let updated = content
  // Highest offset first: an earlier replacement cannot move a later one.
  for (const placement of [...placements].sort((left, right) => right.start - left.start)) {
    updated = `${updated.slice(0, placement.start)}${placement.edit.newText}${updated.slice(placement.end)}`
  }
  return updated
}

export function editFileTool(config: FileToolsConfig): ToolDefinition {
  return {
    schema: {
      name: 'edit_file',
      description: 'Apply literal text edits to one existing file, atomically: every edit applies or nothing changes. Each old_string must appear exactly once unless replace_all is true; a mismatch names the lines it matched. Prefer this over write_file for a small change in a large file, and read the file first. Returns { path, bytes, sha256, edits: [{ line }] }.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'file path relative to the workspace' },
          edits: {
            type: 'array',
            description: 'edits located in the current content and applied together; they must not overlap',
            items: {
              type: 'object',
              properties: {
                old_string: { type: 'string', description: 'exact text to replace; must be unique unless replace_all' },
                new_string: { type: 'string', description: 'text to put in its place' },
                replace_all: { type: 'boolean', description: 'replace every occurrence (default false)' },
              },
              required: ['old_string', 'new_string'],
            },
          },
        },
        required: ['path', 'edits'],
      },
    },
    interruption: 'confirm',
    async execute(input, options: ToolExecuteOptions) {
      const args = record(input)
      const target = await config.resolve(stringField(args.path, 'path'))
      const edits = parseEdits(args.edits)
      const display = config.displayPath(target)
      return await withPathLock(target, async () => {
        if (!await exists(target)) {
          throw new ToolInputError(`${display} does not exist; use write_file to create it`)
        }
        const before = await readFile(target)
        if (before.includes(0)) throw new ToolInputError(`file is binary: ${display}`)
        const text = before.toString('utf8')
        const current: CurrentVersion = { kind: 'present', sha256: fingerprint(before) }
        const verdict = checkObserved(config, options.agentId, target, display, current)
        const placements = placeEdits(text, edits, display)
        const updated = applyPlacements(text, placements)
        const bytes = Buffer.byteLength(updated, 'utf8')
        if (bytes > config.maxWriteBytes) {
          throw new ToolInputError(`edited file would exceed ${config.maxWriteBytes} bytes`)
        }
        await writeFileAtomic(target, updated, { ...(options.signal ? { signal: options.signal } : {}) })
        const sha256 = fingerprint(updated)
        config.observations.record(options.agentId, target, { kind: 'present', sha256 })
        const removed = placements.reduce((total, item) => total + item.edit.oldText.length, 0)
        const added = placements.reduce((total, item) => total + item.edit.newText.length, 0)
        return {
          path: display,
          bytes,
          sha256,
          edits: placements.map(item => ({ line: item.line })),
          removedCharacters: removed,
          addedCharacters: added,
          ...(verdict.warning ? { warning: verdict.warning } : {}),
        }
      })
    },
  }
}
