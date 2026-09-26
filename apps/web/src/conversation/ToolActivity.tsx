import { memo, useState } from 'react'
import { ChatMessage, ChatToolCalls } from '@astryxdesign/core/Chat'
import { Button } from '@astryxdesign/core/Button'
import { boundedText, readSpillNotice } from '../toolOutput'
import type { DisplayMessage, DisplayTool } from '../types'

function toolPresentation(name: string) {
  if (/write|edit|patch/i.test(name))
    return 'Edit file'
  if (/read.*file/i.test(name)) return 'Read file'
  if (/shell|exec|command/i.test(name))
    return 'Run command'
  if (/grep|glob|list_dir|search/i.test(name))
    return 'Search workspace'
  return name
}

function argumentPreview(tool: DisplayTool): string {
  try {
    const args: unknown = JSON.parse(tool.argumentsText)
    if (typeof args === 'object' && args !== null) {
      for (const key of ['command', 'cmd', 'path', 'pattern', 'query']) {
        if (key in args) {
          const value: unknown = Reflect.get(args, key)
          if (typeof value === 'string') return value
        }
      }
    }
  } catch {
    /* Streaming arguments may not be complete JSON yet. */
  }
  return ''
}

export function ToolBlock({ message }: { message: DisplayMessage }) {
  return <ToolGroupBlock tools={[message]} />
}

function ToolDetail({ tool }: { tool: DisplayTool }) {
  const pending = tool.status === 'pending'
  const failed = !pending && tool.ok === false
  return <section className="tool-detail" aria-label={`${tool.name} details`}>
    <div className="tool-detail-meta">
      <code>{tool.name}</code>
      <span title={tool.callId}>{tool.callId.slice(0, 8)}</span>
    </div>
    {tool.argumentsText && <><h4>Input</h4><pre>{tool.argumentsText}</pre></>}
    {pending ? <p className="run-note" role="status">Waiting for tool output…</p> : <><h4>{failed ? 'Error' : 'Output'}</h4><ToolOutput failed={failed} text={failed ? (tool.errorText ?? 'Tool failed') : (tool.outputText ?? 'Completed without text output.')} /></>}
  </section>
}

/**
 * A tool's output, bounded for the page.
 *
 * A result the agent capped for the model ends in a spill notice; that notice
 * is lifted out and shown as the pointer it is — where the rest of the output
 * went — instead of being left as trailing prose inside a wall of text. What
 * remains is rendered at most `MAX_RENDERED_CHARS` long, with the rest one
 * click away: an unbounded `<pre>` is enough to freeze the conversation.
 */
function ToolOutput({ text, failed }: { text: string; failed: boolean }) {
  const [expanded, setExpanded] = useState(false)
  // Only a successful result can carry a spill notice; a failure keeps its
  // message verbatim.
  const notice = failed ? undefined : readSpillNotice(text)
  const body = notice ? notice.preview : text
  const clipped = boundedText(body)
  const visible = expanded ? body : clipped.text
  return (
    <>
      <pre className={`tool-output${failed ? ' tool-error' : ''}`}>
        {visible}
        {clipped.truncated && !expanded ? '\n…' : ''}
      </pre>
      {clipped.truncated && (
        <Button label={expanded ? 'Show less' : `Show all ${clipped.totalChars.toLocaleString()} characters`} variant="ghost" size="sm" onClick={() => setExpanded((open) => !open)} />
      )}
      {notice && (
        <p className="tool-spill" role="note">
          <span className="marker">[spilled]</span>{' '}
          {notice.omittedBytes.toLocaleString()} bytes omitted; full result stored at{' '}
          <code>{notice.locator}</code>. {notice.retrievalHint}
        </p>
      )}
    </>
  )
}

export const ToolGroupBlock = memo(function ToolGroupBlock({ tools }: { tools: DisplayMessage[] }) {
  const calls = tools.flatMap(message => {
    const tool = message.tool
    if (!tool) return []
    const pending = tool.status === 'pending'
    const failed = !pending && tool.ok === false
    return [{
      key: message.id,
      name: toolPresentation(tool.name),
      status: pending ? 'running' as const : failed ? 'error' as const : 'complete' as const,
      target: argumentPreview(tool),
      errorMessage: failed ? tool.errorText : undefined,
      resultDetail: <ToolDetail tool={tool} />,
    }]
  })
  return <ChatMessage sender="assistant" density="compact"><ChatToolCalls calls={calls} defaultIsExpanded={false} /></ChatMessage>
})
