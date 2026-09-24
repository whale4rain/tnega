import { memo, useState } from 'react'
import {
  Check,
  CircleAlert,
  FilePenLine,
  FileText,
  FolderSearch,
  LoaderCircle,
  Terminal,
  Wrench,
} from 'lucide-react'
import { boundedText, readSpillNotice } from '../toolOutput'
import { summarizeToolGroup } from '../toolGroups'
import type { DisplayMessage, DisplayTool } from '../types'
import { Disclosure } from './Disclosure'

function toolPresentation(name: string) {
  if (/write|edit|patch/i.test(name))
    return { icon: FilePenLine, label: 'Edit file' }
  if (/read.*file/i.test(name)) return { icon: FileText, label: 'Read file' }
  if (/shell|exec|command/i.test(name))
    return { icon: Terminal, label: 'Run command' }
  if (/grep|glob|list_dir|search/i.test(name))
    return { icon: FolderSearch, label: 'Search workspace' }
  return { icon: Wrench, label: name }
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
  const tool = message.tool
  if (!tool) return null
  const { icon: Icon, label } = toolPresentation(tool.name)
  const pending = tool.status === 'pending'
  const failed = !pending && tool.ok === false
  const status = pending ? 'Running' : failed ? 'Failed' : 'Completed'
  const StatusIcon = pending ? LoaderCircle : failed ? CircleAlert : Check
  const preview = argumentPreview(tool)
  return (
    <Disclosure
      className={`tool-activity ${failed ? 'failed' : ''}`}
      icon={<Icon size={14} aria-hidden="true" />}
      title={
        <>
          <span>{label}</span>
          {preview && (
            <code className="tool-preview" title={preview}>
              {preview}
            </code>
          )}
        </>
      }
      status={
        <span className={`activity-status ${pending ? 'running' : ''}`}>
          <StatusIcon
            size={12}
            className={pending ? 'activity-spinner' : undefined}
            aria-hidden="true"
          />
          {status}
        </span>
      }
    >
      <div className="tool-detail">
        <div className="tool-detail-meta">
          <code>{tool.name}</code>
          <span title={tool.callId}>{tool.callId.slice(0, 8)}</span>
        </div>
        {tool.argumentsText && (
          <>
            <h4>Input</h4>
            <pre>{tool.argumentsText}</pre>
          </>
        )}
        {pending ? (
          <p className="run-note" role="status">
            Waiting for tool output…
          </p>
        ) : (
          <>
            <h4>{failed ? 'Error' : 'Output'}</h4>
            <ToolOutput
              failed={failed}
              text={failed
                ? (tool.errorText ?? 'Tool failed')
                : (tool.outputText ?? 'Completed without text output.')}
            />
          </>
        )}
      </div>
    </Disclosure>
  )
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
        <button
          type="button"
          className="tool-more"
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded
            ? '[show less]'
            : `[show all ${clipped.totalChars.toLocaleString()} characters]`}
        </button>
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
  if (tools.length === 1) return <ToolBlock message={tools[0]!} />
  const summary = summarizeToolGroup(tools)
  const labels = [
    ...new Set(summary.names.map(({ name }) => toolPresentation(name).label)),
  ]
  const status = [
    summary.running ? `${summary.running} running` : '',
    summary.failed ? `${summary.failed} failed` : '',
    !summary.running && !summary.failed ? 'Completed' : '',
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <Disclosure
      className={`tool-activity tool-group ${summary.failed ? 'failed' : ''}`}
      icon={
        summary.running ? (
          <LoaderCircle size={14} className="activity-spinner" />
        ) : (
          <Wrench size={14} />
        )
      }
      title={
        <>
          <span>{labels.join(' · ')}</span>
          <span className="activity-count">{summary.count}</span>
        </>
      }
      status={status}
    >
      <div className="tool-group-items">
        {tools.map((message) => (
          <ToolBlock key={message.id} message={message} />
        ))}
      </div>
    </Disclosure>
  )
})
