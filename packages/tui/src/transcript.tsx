/**
 * The conversation as terminal rows. Finished entries are printed once into
 * the scrollback (`<Static>` in `app.tsx`); only the running turn is redrawn.
 * Folding follows the web Timeline: a finished turn keeps its answer, the
 * files it changed and anything that needs a look, and the rest of the
 * process becomes one "Used N tools" line (all of it with Ctrl+O).
 */
import {
  formatDuration,
  formatTokens,
  presentLive,
  presentRun,
  presentTool,
  readableOutput,
  type Block,
  type Entry,
  type ToolView,
} from '@tnega/client'
import { Box, Text } from 'ink'
import type { ReactNode } from 'react'
import { Markdown } from './markdown.js'
import { color, glyph, tint } from './theme.js'
import { Spinner } from './spinner.js'
import { stringWidth, truncate } from './width.js'

type AgentEntry = Extract<Entry, { kind: 'agent' }>

export interface EntryProps {
  entry: Entry
  width: number
  /** Show every step instead of folding the process. */
  verbose?: boolean
}

/** One finished entry, as printed into the scrollback. */
export function EntryView({ entry, width, verbose = false }: EntryProps) {
  switch (entry.kind) {
    case 'user':
      return <UserMessage text={entry.text} images={entry.images?.length ?? 0} width={width} />
    case 'agent':
      return <AgentTurn entry={entry} width={width} verbose={verbose} live={false} />
    case 'compaction':
      return (
        <Box marginTop={1}>
          <Text dimColor>{rule(`Context compacted${entry.tokensBefore ? ` from ${formatTokens(entry.tokensBefore)} tokens` : ''}`, width)}</Text>
        </Box>
      )
    case 'setting':
      return (
        <Box marginTop={1}>
          <Text dimColor>{rule(entry.text, width)}</Text>
        </Box>
      )
    case 'slash':
      return (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>{glyph.user} {[entry.command, ...entry.args].join(' ')}</Text>
          <Box paddingLeft={2}>
            {entry.result.kind === 'text'
              ? <Markdown text={entry.result.text} width={width - 2} />
              : <Text>{JSON.stringify(entry.result.value, null, 2)}</Text>}
          </Box>
        </Box>
      )
  }
}

function UserMessage({ text, images, width }: { text: string; images: number; width: number }) {
  return (
    <Box marginTop={1} flexDirection="row" width={width}>
      <Box width={2} flexShrink={0}><Text dimColor>{glyph.user}</Text></Box>
      <Box flexDirection="column" flexGrow={1}>
        <Text bold>{text}</Text>
        {images > 0 && <Text dimColor>{images === 1 ? '1 image' : `${images} images`}</Text>}
      </Box>
    </Box>
  )
}

export interface TurnProps {
  entry: AgentEntry
  width: number
  verbose: boolean
  live: boolean
  /** Rows the live turn may take before older lines scroll off the top. */
  maxRows?: number
}

export function AgentTurn({ entry, width, verbose, live, maxRows }: TurnProps) {
  const inner = width - 2
  if (live) {
    const groups = groupTools(presentLive(entry).visible)
    const shown = maxRows === undefined ? groups : fitGroups(groups, inner, maxRows)
    return (
      <Box marginTop={1} flexDirection="column" paddingLeft={2} width={width}>
        {shown.length < groups.length && <Text dimColor>…</Text>}
        {shown.map((group, index) => <Gap key={group.key} first={index === 0 && shown.length === groups.length}><BlockGroup group={group} width={inner} live verbose={verbose} /></Gap>)}
      </Box>
    )
  }
  const { process, visible } = verbose ? { process: [], visible: entry.blocks } : presentRun(entry)
  const tools = process.filter(block => block.kind === 'tool' || block.kind === 'subagent').length
  const status = entry.status === 'stopped' ? 'Stopped' : entry.status === 'error' ? 'Failed' : undefined
  return (
    <Box marginTop={1} flexDirection="column" paddingLeft={2} width={width}>
      {process.length > 0 && (
        <Text dimColor>{tools ? `Used ${tools} ${tools === 1 ? 'tool' : 'tools'}` : 'Worked through some steps'}{verbose ? '' : ' · Ctrl+O to show'}</Text>
      )}
      {groupTools(visible).map((group, index) => <Gap key={group.key} first={index === 0 && process.length === 0}><BlockGroup group={group} width={inner} live={false} verbose={verbose} /></Gap>)}
      {status && !visible.some(block => block.kind === 'notice') && <Text {...tint(entry.status === 'error' ? color.danger : undefined)} dimColor={entry.status !== 'error'}>{status}</Text>}
    </Box>
  )
}

/** One blank row between the blocks of a turn. */
function Gap({ first, children }: { first: boolean; children: ReactNode }) {
  return <Box flexDirection="column" marginTop={first ? 0 : 1}>{children}</Box>
}

type Group =
  | { key: string; kind: 'block'; block: Block }
  /** Consecutive tool calls, drawn as one line while the turn runs. */
  | { key: string; kind: 'tools'; tools: ToolView[] }

function groupTools(blocks: readonly Block[]): Group[] {
  const groups: Group[] = []
  for (const block of blocks) {
    const last = groups.at(-1)
    if (block.kind === 'tool') {
      if (last?.kind === 'tools') last.tools.push(block.tool)
      else groups.push({ key: block.id, kind: 'tools', tools: [block.tool] })
    } else {
      groups.push({ key: block.id, kind: 'block', block })
    }
  }
  return groups
}

/** Keep the newest groups that fit in `rows`, cutting the oldest text from the top. */
function fitGroups(groups: readonly Group[], width: number, rows: number): Group[] {
  const kept: Group[] = []
  let used = 0
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    const group = groups[i]!
    const height = groupHeight(group, width)
    if (used + height <= rows) {
      kept.unshift(group)
      used += height
      continue
    }
    const room = rows - used
    if (group.kind === 'block' && (group.block.kind === 'text' || group.block.kind === 'reasoning') && room > 2) {
      kept.unshift({ ...group, block: { ...group.block, text: tailRows(group.block.text, width, room) } })
    }
    break
  }
  return kept
}

function groupHeight(group: Group, width: number): number {
  if (group.kind === 'tools') return 1
  const block = group.block
  if (block.kind === 'text') return wrappedRows(block.text, width) + 1
  if (block.kind === 'reasoning') return block.streaming ? Math.min(7, wrappedRows(block.text, width) + 1) : 1
  return 2
}

function wrappedRows(text: string, width: number): number {
  return text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(stringWidth(line) / Math.max(1, width))), 0)
}

/** The last lines of `text` that fill at most `rows` wrapped rows. */
export function tailRows(text: string, width: number, rows: number): string {
  const lines = text.split('\n')
  const kept: string[] = []
  let used = 0
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!
    const height = Math.max(1, Math.ceil(stringWidth(line) / Math.max(1, width)))
    if (used + height > rows) break
    kept.unshift(line)
    used += height
  }
  return kept.join('\n')
}

function BlockGroup({ group, width, live, verbose }: { group: Group; width: number; live: boolean; verbose: boolean }) {
  if (group.kind === 'tools') {
    if (live && !verbose) return <ToolSummary tools={group.tools} width={width} />
    return <Box flexDirection="column">{group.tools.map(tool => <ToolRow key={tool.callId} tool={tool} width={width} verbose={verbose} />)}</Box>
  }
  const block = group.block
  switch (block.kind) {
    case 'text':
      return block.text.trim() ? <Markdown text={block.text} width={width} /> : null
    case 'reasoning':
      return <Reasoning text={block.text} streaming={Boolean(block.streaming)} durationMs={block.durationMs} width={width} verbose={verbose} />
    case 'tool':
      return <ToolRow tool={block.tool} width={width} verbose={verbose} />
    case 'subagent': {
      const agent = block.agent
      const failed = agent.status === 'failed'
      return (
        <Text dimColor={!failed} {...tint(failed ? color.danger : undefined)}>
          {agent.status === 'running' || agent.status === 'starting' ? <Spinner /> : failed ? glyph.fail : glyph.ok} {truncate(`${agent.label} · ${agent.task}`, width - 2)}
        </Text>
      )
    }
    case 'files':
      return (
        <Box flexDirection="column">
          <Text dimColor>{block.files.length === 1 ? 'Changed 1 file' : `Changed ${block.files.length} files`}</Text>
          {block.files.map(file => (
            <Text key={file.path}>
              {'  '}{truncate(file.path, width - 16)}
              {file.additions ? <Text color={color.success}> +{file.additions}</Text> : null}
              {file.deletions ? <Text color={color.danger}> −{file.deletions}</Text> : null}
            </Text>
          ))}
        </Box>
      )
    case 'setting':
      return <Text dimColor>{truncate(block.text, width)}</Text>
    case 'notice':
      return (
        <Box>
          <Text {...tint(block.tone === 'error' ? color.danger : block.tone === 'warn' ? color.warn : undefined)} dimColor={block.tone === 'info'}>{block.text}</Text>
        </Box>
      )
  }
}

function Reasoning({ text, streaming, durationMs, width, verbose }: { text: string; streaming: boolean; durationMs: number | undefined; width: number; verbose: boolean }) {
  if (streaming) {
    return (
      <Box flexDirection="column">
        <Text dimColor><Spinner /> Thinking</Text>
        <Box borderStyle="single" borderTop={false} borderRight={false} borderBottom={false} borderDimColor paddingLeft={1}>
          <Text dimColor italic>{tailRows(text, width - 2, 6)}</Text>
        </Box>
      </Box>
    )
  }
  const label = durationMs !== undefined ? `Thought for ${formatDuration(durationMs)}` : 'Thought'
  if (!verbose) return <Text dimColor>{label}</Text>
  return (
    <Box flexDirection="column">
      <Text dimColor>{label}</Text>
      <Box borderStyle="single" borderTop={false} borderRight={false} borderBottom={false} borderDimColor paddingLeft={1}>
        <Text dimColor italic>{text}</Text>
      </Box>
    </Box>
  )
}

/** A run of tool calls while the turn is going: the current step and how many so far. */
function ToolSummary({ tools, width }: { tools: readonly ToolView[]; width: number }) {
  const current = tools.findLast(tool => tool.status === 'running') ?? tools.at(-1)!
  const step = presentTool(current)
  const running = tools.some(tool => tool.status === 'running')
  const count = tools.length > 1 ? ` · ${tools.length} steps` : ''
  const text = `${step.verb}${step.target ? ` ${step.target}` : ''}`
  return (
    <Box>
      <Text dimColor={!running}>
        {running ? <Spinner /> : glyph.ok} {truncate(text, width - 4 - stringWidth(count))}<Text dimColor>{count}</Text>
      </Text>
    </Box>
  )
}

export function ToolRow({ tool, width, verbose }: { tool: ToolView; width: number; verbose: boolean }) {
  const step = presentTool(tool)
  const duration = tool.durationMs !== undefined ? `  ${formatDuration(tool.durationMs)}` : ''
  const failed = tool.status === 'error'
  const mark = tool.status === 'running' ? <Spinner /> : failed ? glyph.fail : glyph.ok
  const label = `${step.verb}${step.target ? ` ${step.target}` : ''}`
  const output = verbose ? toolOutput(tool) : ''
  return (
    <Box flexDirection="column">
      <Text dimColor={!failed && tool.status !== 'running'} {...tint(failed ? color.danger : undefined)}>
        {mark} {truncate(label, width - 2 - duration.length)}<Text dimColor>{duration}</Text>
      </Text>
      {failed && tool.error && <Box paddingLeft={2}><Text color={color.danger}>{truncate(tool.error.split('\n')[0] ?? '', width - 2)}</Text></Box>}
      {output && (
        <Box paddingLeft={2}>
          <Text dimColor>{output}</Text>
        </Box>
      )}
    </Box>
  )
}

/** The first lines of a tool's output, for the expanded transcript. */
function toolOutput(tool: ToolView): string {
  const { text } = readableOutput(tool.output)
  if (!text.trim()) return ''
  const lines = text.trimEnd().split('\n')
  const head = lines.slice(0, 12).join('\n')
  return lines.length > 12 ? `${head}\n… ${lines.length - 12} more lines` : head
}

function rule(label: string, width: number): string {
  const text = ` ${label} `
  const side = Math.max(2, Math.floor((Math.min(width, 72) - stringWidth(text)) / 2))
  return `${glyph.rule.repeat(side)}${text}${glyph.rule.repeat(side)}`
}
