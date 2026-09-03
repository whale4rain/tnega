import { prettyJson } from './api'
import { formatSlashMessage, readSlashMetaEvent } from './planDisplay'
import type {
  CancelCause,
  DisplayEndState,
  DisplayMessage,
  DisplayRetry,
  ModelMessage,
  SessionEvent,
} from './types'

type EndPayload = {
  finishReason?: string
  interrupted?: boolean
  cancelCause?: CancelCause
  error?: { name?: string; message: string; stack?: string }
}

export function projectEvents(events: SessionEvent[]): DisplayMessage[] {
  const messages: DisplayMessage[] = []
  const toolIndex = new Map<string, number>()
  let turnStart = 0
  let turnOpen = false
  for (const event of events) {
    switch (event.type) {
      case 'user/message':
        if (event.payload.content) {
          messages.push({
            id: event.id,
            role: 'user',
            content: event.payload.content,
          })
        }
        break
      case 'assistant/message':
        if (event.payload.content) {
          messages.push({
            id: event.id,
            role: 'assistant',
            content: event.payload.content,
            ...(event.payload.interrupted ? { interrupted: true } : {}),
          })
        }
        break
      case 'assistant/chunk':
      case 'compaction/start':
      case 'compaction/end':
        break
      case 'system/message':
        // System prompts are raw model context, not part of the transcript.
        break
      case 'tool/call':
        messages.push({
          id: event.id,
          role: 'tool',
          content: '',
          tool: {
            callId: event.payload.id,
            name: event.payload.name,
            argumentsText: prettyJson(event.payload.arguments),
            status: 'pending',
          },
        })
        toolIndex.set(event.payload.id, messages.length - 1)
        break
      case 'tool/result': {
        const index = toolIndex.get(event.payload.toolCallId)
        if (index === undefined) {
          messages.push({
            id: event.id,
            role: 'tool',
            content: '',
            tool: {
              callId: event.payload.toolCallId,
              name: event.payload.name,
              argumentsText: '',
              status: 'done',
              ok: event.payload.ok,
              outputText: event.payload.output === undefined
                ? undefined
                : prettyJson(event.payload.output),
              errorText: event.payload.error?.message,
            },
          })
        } else {
          const target = messages[index]
          if (target?.tool) {
            target.tool.status = 'done'
            target.tool.ok = event.payload.ok
            target.tool.outputText = event.payload.output === undefined
              ? undefined
              : prettyJson(event.payload.output)
            target.tool.errorText = event.payload.error?.message
          }
        }
        break
      }
      case 'checkpoint': {
        messages.splice(0, messages.length)
        toolIndex.clear()
        for (const item of event.payload.messages) {
          pushModelMessage(messages, toolIndex, item, event.id)
        }
        messages.push({
          id: event.id,
          role: 'system',
          content: event.payload.summary ?? '',
          compacted: true,
          tokensBefore: event.payload.tokensBefore,
        })
        break
      }
      case 'meta': {
        const slash = readSlashMetaEvent(event)
        if (slash) {
          messages.push({
            id: event.id,
            role: 'system',
            content: formatSlashMessage(slash.command, slash.args, slash.result),
            slash,
          })
        }
        break
      }
      case 'llm/retry': {
        const retry: DisplayRetry = {
          retryId: event.payload.retryId,
          retry: event.payload.retry,
          ...(event.payload.delayMs !== undefined
            ? { delayMs: event.payload.delayMs }
            : {}),
          ...(event.payload.failure ? { failure: event.payload.failure } : {}),
        }
        const from = turnOpen ? Math.min(turnStart, messages.length) : 0
        const target = lastAssistantFrom(messages, from)
        if (target) {
          target.retry = retry
        } else {
          messages.push({
            id: event.id,
            role: 'system',
            content: `[retry ${event.payload.retry}]`,
            retry,
          })
        }
        break
      }
      case 'llm/retry-started': {
        const from = turnOpen ? Math.min(turnStart, messages.length) : 0
        for (let index = messages.length - 1; index >= from; index -= 1) {
          const entry = messages[index]
          if (entry?.retry?.retryId === event.payload.retryId) {
            entry.retry.started = true
            break
          }
        }
        break
      }
      case 'turn/start':
        turnStart = messages.length
        turnOpen = true
        break
      case 'turn/end': {
        const from = turnOpen ? Math.min(turnStart, messages.length) : 0
        attachEndState(messages, from, event.payload, true, event.id)
        turnOpen = false
        break
      }
      case 'step/start':
        break
      case 'step/end': {
        const from = turnOpen ? Math.min(turnStart, messages.length) : 0
        attachEndState(messages, from, event.payload, false, event.id)
        break
      }
    }
  }
  return messages
}

function pushModelMessage(
  messages: DisplayMessage[],
  toolIndex: Map<string, number>,
  item: ModelMessage,
  sourceId: string,
): void {
  if (item.role === 'system') return
  if (item.role === 'tool') {
    const index = toolIndex.get(item.tool_call_id ?? '')
    const legacyFailed = item.content.startsWith('error: ')
    const failed = item.toolOk === false
      || (item.toolOk === undefined && legacyFailed)
    const errorText = item.toolError?.message
      ?? (legacyFailed ? item.content.slice(7) : undefined)
    if (index !== undefined && messages[index]?.tool) {
      const target = messages[index]!.tool!
      target.status = 'done'
      target.ok = !failed
      target.errorText = errorText
      target.outputText = failed ? undefined : item.content
    } else {
      messages.push({
        id: `${sourceId}-${messages.length}`,
        role: 'tool',
        content: '',
        tool: {
          callId: item.tool_call_id ?? '',
          name: item.name ?? 'tool',
          argumentsText: '',
          status: 'done',
          ok: !failed,
          outputText: failed ? undefined : item.content,
          errorText,
        },
      })
    }
    return
  }
  if (item.role === 'user' || item.role === 'assistant') {
    messages.push({
      id: `${sourceId}-${messages.length}`,
      role: item.role,
      content: item.content,
    })
    for (const call of item.tool_calls ?? []) {
      messages.push({
        id: `${sourceId}-tool-${call.id}`,
        role: 'tool',
        content: '',
        tool: {
          callId: call.id,
          name: call.name,
          argumentsText: prettyJson(call.arguments),
          status: 'pending',
        },
      })
      toolIndex.set(call.id, messages.length - 1)
    }
  }
}

function lastAssistantFrom(
  messages: DisplayMessage[],
  fromIndex: number,
): DisplayMessage | undefined {
  for (let index = messages.length - 1; index >= fromIndex; index -= 1) {
    const entry = messages[index]
    if (entry && entry.role === 'assistant') return entry
  }
  return undefined
}

function attachEndState(
  messages: DisplayMessage[],
  fromIndex: number,
  payload: EndPayload,
  pushFallback: boolean,
  fallbackId: string,
): void {
  if (!payload.interrupted && !payload.cancelCause && !payload.error) return
  const endState: DisplayEndState = {
    ...(payload.finishReason ? { finishReason: payload.finishReason } : {}),
    ...(payload.interrupted ? { interrupted: true } : {}),
    ...(payload.cancelCause ? { cancelCause: payload.cancelCause } : {}),
    ...(payload.error ? { error: payload.error } : {}),
  }
  const target = lastAssistantFrom(messages, fromIndex)
  if (target) {
    if (payload.interrupted) target.interrupted = true
    target.endState = endState
    return
  }
  if (!pushFallback) return
  const marker = endMarker(payload)
  if (!marker) return
  messages.push({
    id: fallbackId,
    role: 'system',
    content: marker,
    endState,
  })
}

function endMarker(payload: EndPayload): string {
  if (payload.cancelCause) return `[cancel ${formatCancelCause(payload.cancelCause)}]`
  if (payload.error) return `[error: ${payload.error.message}]`
  if (payload.interrupted) return '[interrupted]'
  return ''
}

export function formatCancelCause(cause: CancelCause): string {
  switch (cause.type) {
    case 'user':
      return 'user'
    case 'abort':
      return cause.message ? `abort: ${cause.message}` : 'abort'
    case 'timeout':
      return `timeout ${cause.timeoutMs}ms`
  }
}
