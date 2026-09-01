import type { DisplayMessage } from './types'

export type MessageRenderItem =
  | { kind: 'message'; message: DisplayMessage; sourceIndex: number }
  | { kind: 'tools'; tools: DisplayMessage[] }

export function groupToolMessages(messages: DisplayMessage[]): MessageRenderItem[] {
  const items: MessageRenderItem[] = []
  let tools: DisplayMessage[] = []
  const flushTools = () => {
    if (!tools.length) return
    items.push({ kind: 'tools', tools })
    tools = []
  }

  messages.forEach((message, sourceIndex) => {
    if (message.role === 'tool') {
      tools.push(message)
      return
    }
    flushTools()
    items.push({ kind: 'message', message, sourceIndex })
  })
  flushTools()
  return items
}

export interface ToolGroupSummary {
  count: number
  names: Array<{ name: string; count: number }>
  ok: number
  failed: number
  running: number
  done: number
}

export function summarizeToolGroup(tools: DisplayMessage[]): ToolGroupSummary {
  const nameCounts = new Map<string, number>()
  let ok = 0
  let failed = 0
  let running = 0
  let done = 0

  for (const message of tools) {
    const tool = message.tool
    const name = tool?.name || 'tool'
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1)
    if (!tool) continue
    if (tool.status === 'pending') running += 1
    else if (tool.ok === true) ok += 1
    else if (tool.ok === false) failed += 1
    else done += 1
  }

  return {
    count: tools.length,
    names: [...nameCounts.entries()].map(([name, count]) => ({ name, count })),
    ok,
    failed,
    running,
    done,
  }
}

export function formatToolGroupNames(
  names: Array<{ name: string; count: number }>,
): string {
  return names
    .map(entry => entry.count > 1 ? `${entry.name} x${entry.count}` : entry.name)
    .join(', ')
}

export function formatToolGroupStatus(summary: ToolGroupSummary): string {
  const parts: string[] = []
  if (summary.running) parts.push(`${summary.running} running`)
  if (summary.ok) parts.push(`${summary.ok} ok`)
  if (summary.failed) parts.push(`${summary.failed} err`)
  if (summary.done) parts.push(`${summary.done} done`)
  if (parts.length) return parts.join(' / ')
  return summary.count === 1 ? '1 tool' : `${summary.count} tools`
}
