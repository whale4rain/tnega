import type { DisplayMessage } from './types.js'

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
    // Streaming emits empty assistant placeholders around tool calls. They are
    // not prose and must not split a single activity group into separate rows.
    if (
      message.role === 'assistant' && !message.content.trim() &&
      !message.interrupted && !message.retry &&
      !message.endState?.error && !message.endState?.cancelCause &&
      (!message.pending || tools.length > 0 ||
        messages[sourceIndex + 1]?.role === 'tool' ||
        messages[sourceIndex + 1]?.role === 'subagent')
    ) return
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
