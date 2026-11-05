import { basename, extname, relative, sep } from 'node:path'
import type { Context } from '@tnega/core'
import type { WorkspaceFs } from '@tnega/fs'
import { PathSandboxError, ToolInputError, record, type ToolDefinition } from '@tnega/tools'

export const SEND_FILE_TOOL_NAME = 'send_file'
export const MAX_SENT_FILES = 10

export interface ToolSendFileConfig {
  /** Workspace root. A sent file must be inside it, whatever the permission: the clients read it from there. */
  cwd?: string
}

/** One file the agent handed to the person, as the clients render it. */
export interface SentFile {
  /** Workspace-relative, with `/` separators. */
  path: string
  name: string
  size: number
  kind: 'image' | 'file'
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif'])

function paths(input: unknown): string[] {
  const args = record(input)
  const raw = args.paths ?? (args.path === undefined ? undefined : [args.path])
  if (!Array.isArray(raw) || raw.length === 0) throw new ToolInputError('paths must list at least one workspace file')
  if (raw.length > MAX_SENT_FILES) throw new ToolInputError(`paths may list at most ${MAX_SENT_FILES} files`)
  return raw.map((value, index) => {
    if (typeof value !== 'string' || !value.trim()) throw new ToolInputError(`paths[${index}] must be a file path`)
    return value
  })
}

/**
 * Model-facing `send_file`: put workspace files in front of the person, in the
 * reply itself. Images show inline and anything else as a file card that opens
 * in the Workbench. Nothing is copied or read into the model's context: the
 * durable call is the record, and the clients load the bytes from the
 * workspace when they render it.
 */
export function createSendFileTool(fs: WorkspaceFs): ToolDefinition {
  return {
    schema: {
      name: SEND_FILE_TOOL_NAME,
      description: 'Show workspace files to the user in your reply: images (png, jpg, gif, webp, svg) appear inline, any other file as a card they can open. Use it for a chart, screenshot, report or document you made or found that the user should look at. Write the file first; paths are workspace-relative. The user sees the file, you get only its name and size back.',
      parameters: {
        type: 'object',
        properties: {
          paths: { type: 'array', minItems: 1, maxItems: MAX_SENT_FILES, items: { type: 'string' }, description: 'Workspace-relative file paths, in the order to show them.' },
        },
        required: ['paths'],
      },
    },
    metadata: { readOnly: true },
    isConcurrencySafe: () => true,
    async execute(input) {
      const files: SentFile[] = []
      for (const path of paths(input)) {
        let target: string
        try {
          target = await fs.resolve(path)
        } catch (error) {
          if (error instanceof PathSandboxError) throw new ToolInputError(`${path} is outside the workspace; copy it into the workspace first`)
          throw error
        }
        const info = await fs.stat(target).catch(() => undefined)
        if (!info) throw new ToolInputError(`${path} does not exist`)
        if (info.kind !== 'file') throw new ToolInputError(`${path} is not a file`)
        // `resolve` follows symlinks, so the path is shown from the followed root.
        const shown = relative(await fs.realRoot(), target).split(sep).join('/')
        files.push({
          path: shown,
          name: basename(target),
          size: info.size,
          kind: IMAGE_EXTENSIONS.has(extname(target).toLowerCase()) ? 'image' : 'file',
        })
      }
      return { sent: files }
    },
  }
}

export const toolSendFile = {
  name: 'tool-send-file',
  inject: ['tools', 'fs'],
  apply(ctx: Context, config: ToolSendFileConfig = {}): void {
    // Always fenced, whatever the permission: the clients read the file from the workspace.
    ctx.tools.register(createSendFileTool(ctx.fs.workspace(config.cwd ?? process.cwd())))
  },
}
