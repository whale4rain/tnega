/**
 * What a turn handed the person besides words: files the agent sent with
 * `send_file` and interfaces it showed with `show_ui`. Both come from durable
 * tool calls, so a reloaded Session shows the same reply as the live one.
 */
import { parseSurface, type A2uiSurface } from '@tnega/a2ui'
import type { Block, ToolView } from './timeline.js'

export { formatAction, initialValues, isInteractive, parseAction, type A2uiAction, type A2uiComponent, type A2uiSurface, type A2uiValue } from '@tnega/a2ui'

export const SEND_FILE_TOOL = 'send_file'
export const UI_TOOL = 'show_ui'

export interface SentFile {
  path: string
  name: string
  size: number
  kind: 'image' | 'file'
}

export type ReplyItem =
  | { kind: 'files'; id: string; files: SentFile[] }
  | { kind: 'ui'; id: string; surface: A2uiSurface }

function sentFiles(output: unknown): SentFile[] {
  if (!output || typeof output !== 'object' || !('sent' in output) || !Array.isArray(output.sent)) return []
  return output.sent.flatMap((entry: unknown): SentFile[] => {
    if (!entry || typeof entry !== 'object') return []
    const { path, name, size, kind } = entry as Record<string, unknown>
    if (typeof path !== 'string' || typeof name !== 'string') return []
    return [{ path, name, size: typeof size === 'number' ? size : 0, kind: kind === 'image' ? 'image' : 'file' }]
  })
}

/** The reply item one finished tool call produced, if any. */
export function replyItem(tool: ToolView): ReplyItem | undefined {
  if (tool.status !== 'ok') return undefined
  if (tool.name === SEND_FILE_TOOL) {
    const files = sentFiles(tool.output)
    return files.length ? { kind: 'files', id: tool.callId, files } : undefined
  }
  if (tool.name === UI_TOOL) {
    try {
      return { kind: 'ui', id: tool.callId, surface: parseSurface(tool.args) }
    } catch {
      return undefined
    }
  }
  return undefined
}

/** Whether a tool call is shown as part of the reply rather than as a step. */
export function isReplyTool(tool: ToolView): boolean {
  return replyItem(tool) !== undefined
}

/** Every reply item of a turn, in call order, including calls made inside CodeMode. */
export function replyItems(blocks: readonly Block[]): ReplyItem[] {
  const items: ReplyItem[] = []
  const visit = (tool: ToolView): void => {
    const item = replyItem(tool)
    if (item) items.push(item)
    tool.children?.forEach(visit)
  }
  for (const block of blocks) if (block.kind === 'tool') visit(block.tool)
  return items
}

