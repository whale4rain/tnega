/**
 * Panels opened by slash commands: usage, settings, changes, help. Each one
 * replaces the composer until Esc, and keeps within the rows it is given so
 * the live area never outgrows the terminal.
 */
import {
  formatCost,
  formatRate,
  formatTokens,
  type Api,
  type ChangeSummary,
  type CommandSpec,
  type ConfigSnapshot,
  type FileDiff,
  type UsageTotals,
  type WorkspaceUsage,
} from '@tnega/client'
import { structuredPatch } from 'diff'
import { Box, Text, useInput } from 'ink'
import { useEffect, useState, type ReactNode } from 'react'
import type { RunSettings } from './controller.js'
import { errorText } from './controller.js'
import { Picker } from './picker.js'
import { color, tint } from './theme.js'
import { padEnd, truncate } from './width.js'

function Frame({ title, children, hint, width }: { title: string; children: ReactNode; hint?: string; width: number }) {
  return (
    <Box flexDirection="column" width={width} marginTop={1}>
      <Text bold>{title}</Text>
      {children}
      <Text dimColor>{hint ? `${hint} · ` : ''}esc close</Text>
    </Box>
  )
}

function useClose(onClose: () => void, extra?: (input: string) => void) {
  useInput((input, key) => {
    if (key.escape || input === 'q') onClose()
    else extra?.(input)
  })
}

// --- usage -------------------------------------------------------------------

export function UsageView({ api, workspace, onClose, width }: { api: Api; workspace: string; onClose: () => void; width: number }) {
  const [usage, setUsage] = useState<WorkspaceUsage>()
  const [error, setError] = useState<string>()
  useClose(onClose)
  useEffect(() => {
    const controller = new AbortController()
    api.usage(workspace, controller.signal).then(setUsage, reason => !controller.signal.aborted && setError(errorText(reason)))
    return () => controller.abort()
  }, [api, workspace])
  const row = (label: string, totals: UsageTotals) => [
    label,
    String(totals.responses),
    formatTokens(totals.promptTokens),
    formatTokens(totals.completionTokens),
    formatRate(totals.cacheHitRate) ?? '–',
    formatCost(totals.cost) ?? '–',
  ]
  const head = ['', 'Replies', 'Input', 'Output', 'Cache hit', 'Cost']
  const table = usage
    ? [row('Today', usage.today), row('This week', usage.week), row('All time', usage.total)]
    : []
  const widths = head.map((cell, index) => Math.max(cell.length, ...table.map(cells => cells[index]!.length)) + 2)
  const line = (cells: readonly string[]) => cells.map((cell, index) => padEnd(cell, widths[index]!)).join('')
  return (
    <Frame title="Usage in this folder" width={width}>
      {error && <Text color={color.danger}>{error}</Text>}
      {!usage && !error && <Text dimColor>Loading…</Text>}
      {usage && (
        <Box flexDirection="column">
          <Text dimColor>{line(head)}</Text>
          {table.map(cells => <Text key={cells[0]}>{line(cells)}</Text>)}
          {usage.byModel.length > 0 && <Box marginTop={1}><Text dimColor>By model</Text></Box>}
          {usage.byModel.slice(0, 6).map(model => (
            <Text key={model.modelId}>
              {padEnd(truncate(model.name || model.modelId, 28), 30)}
              <Text dimColor>{formatTokens(model.promptTokens + model.completionTokens)} tokens · {formatCost(model.cost) ?? (model.priced ? '–' : 'no price set')}</Text>
            </Text>
          ))}
        </Box>
      )}
    </Frame>
  )
}

// --- settings ----------------------------------------------------------------

const PERMISSIONS: RunSettings['permission'][] = ['read-only', 'workspace-write', 'bypass']
const AGENTS: RunSettings['agentType'][] = ['coding', 'general', 'work']
const EFFORTS: RunSettings['reasoningEffort'][] = ['default', 'low', 'medium', 'high']

function cycle<T>(values: readonly T[], current: T): T {
  return values[(values.indexOf(current) + 1) % values.length]!
}

export function SettingsView({ config, settings, sessionOpen, onChange, onClose, width }: {
  config: ConfigSnapshot | undefined
  settings: RunSettings
  sessionOpen: boolean
  onChange: (patch: Partial<RunSettings>) => void
  onClose: () => void
  width: number
}) {
  useClose(onClose, input => {
    if (input === 'p') onChange({ permission: cycle(PERMISSIONS, settings.permission) })
    if (input === 'a') onChange({ approvalMode: settings.approvalMode === 'manual' ? 'auto' : 'manual' })
    if (input === 't' && !sessionOpen) onChange({ agentType: cycle(AGENTS, settings.agentType) })
    if (input === 'e') onChange({ reasoningEffort: cycle(EFFORTS, settings.reasoningEffort) })
  })
  const key = (letter: string, label: string, value: string, note?: string) => (
    <Text key={letter}>
      <Text bold>{letter}</Text> <Text dimColor>{padEnd(label, 14)}</Text>{value}{note ? <Text dimColor>  {note}</Text> : null}
    </Text>
  )
  const effective = config?.effective
  const routes = config?.config.models ?? []
  return (
    <Frame title={sessionOpen ? 'Settings for this session' : 'Settings for new sessions'} width={width} hint="press a letter to change">
      {key('t', 'Agent', settings.agentType, sessionOpen ? 'fixed once a session starts' : undefined)}
      {key('p', 'Permission', settings.permission, settings.permission === 'bypass' ? 'no sandbox' : undefined)}
      {key('a', 'Approvals', settings.approvalMode, settings.approvalMode === 'auto' ? 'a reviewer decides' : 'you decide')}
      {key('e', 'Effort', settings.reasoningEffort)}
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>System</Text>
        <Text>  {padEnd('Model', 14)}{effective ? `${effective.modelId}` : '–'}<Text dimColor>{effective?.baseUrl ? `  ${effective.baseUrl}` : ''}</Text></Text>
        <Text>  {padEnd('API key', 14)}{config?.apiKeySet || config?.models.some(model => model.apiKeySet) ? 'set' : <Text color={color.warn}>missing</Text>}</Text>
        <Text>  {padEnd('CodeMode', 14)}{config?.config.codeMode ? 'on' : 'off'}<Text dimColor>  /codemode on|off</Text></Text>
        {config?.shell && <Text>  {padEnd('Shell', 14)}{config.shell.active}</Text>}
        <Text>  {padEnd('Model routes', 14)}{routes.length ? routes.map(route => route.name || route.id).join(', ') : 'none'}</Text>
        {config && <Text dimColor>  {truncate(config.config.path, width - 4)}</Text>}
        <Text dimColor>  Model routes, keys and network rules are edited in the web app (/web).</Text>
      </Box>
    </Frame>
  )
}

// --- changes -----------------------------------------------------------------

export function ChangesView({ api, workspace, onClose, width, rows }: { api: Api; workspace: string; onClose: () => void; width: number; rows: number }) {
  const [summary, setSummary] = useState<ChangeSummary>()
  const [error, setError] = useState<string>()
  const [open, setOpen] = useState<string>()
  useEffect(() => {
    const controller = new AbortController()
    api.changes(workspace, controller.signal).then(setSummary, reason => !controller.signal.aborted && setError(errorText(reason)))
    return () => controller.abort()
  }, [api, workspace])
  if (open) return <DiffView api={api} workspace={workspace} path={open} onClose={() => setOpen(undefined)} width={width} rows={rows} />
  if (!summary) {
    return <Frame title="Changes" width={width}><Text {...tint(error ? color.danger : undefined)} dimColor={!error}>{error ?? 'Loading…'}</Text><CloseKeys onClose={onClose} /></Frame>
  }
  if (!summary.git) {
    return <Frame title="Changes" width={width}><Text dimColor>This folder is not a git repository.</Text><CloseKeys onClose={onClose} /></Frame>
  }
  const items = summary.files.map(file => ({
    key: file.path,
    label: file.previousPath ? `${file.previousPath} → ${file.path}` : file.path,
    detail: [file.status, file.additions ? `+${file.additions}` : '', file.deletions ? `−${file.deletions}` : ''].filter(Boolean).join(' '),
  }))
  return (
    <Picker
      title={`Changes${summary.branch ? ` on ${summary.branch}` : ''} · ${summary.files.length} ${summary.files.length === 1 ? 'file' : 'files'}`}
      items={items}
      empty="Nothing changed since the last commit."
      onPick={item => setOpen(item.key)}
      onClose={onClose}
      width={width}
      rows={rows - 3}
    />
  )
}

function CloseKeys({ onClose }: { onClose: () => void }) {
  useClose(onClose)
  return null
}

export function diffLines(diff: FileDiff): Array<{ kind: 'add' | 'del' | 'hunk' | 'same'; text: string }> {
  if (diff.reason) return [{ kind: 'hunk', text: diff.reason === 'binary' ? 'Binary file' : 'Too large to show' }]
  const patch = structuredPatch(diff.path, diff.path, diff.original ?? '', diff.modified ?? '', undefined, undefined, { context: 3 })
  return patch.hunks.flatMap(hunk => [
    { kind: 'hunk' as const, text: `@@ −${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@` },
    ...hunk.lines.map(line => ({
      kind: line.startsWith('+') ? 'add' as const : line.startsWith('-') ? 'del' as const : 'same' as const,
      text: line,
    })),
  ])
}

function DiffView({ api, workspace, path, onClose, width, rows }: { api: Api; workspace: string; path: string; onClose: () => void; width: number; rows: number }) {
  const [lines, setLines] = useState<ReturnType<typeof diffLines>>()
  const [error, setError] = useState<string>()
  const [top, setTop] = useState(0)
  const page = Math.max(3, rows - 3)
  useEffect(() => {
    const controller = new AbortController()
    api.fileDiff(workspace, path, controller.signal).then(diff => setLines(diffLines(diff)), reason => !controller.signal.aborted && setError(errorText(reason)))
    return () => controller.abort()
  }, [api, workspace, path])
  const max = Math.max(0, (lines?.length ?? 0) - page)
  useInput((input, key) => {
    if (key.escape || input === 'q') onClose()
    else if (key.upArrow || input === 'k') setTop(Math.max(0, top - 1))
    else if (key.downArrow || input === 'j') setTop(Math.min(max, top + 1))
    else if (key.pageUp || input === 'b') setTop(Math.max(0, top - page))
    else if (key.pageDown || input === ' ') setTop(Math.min(max, top + page))
  })
  return (
    <Box flexDirection="column" width={width} marginTop={1}>
      <Text bold>{truncate(path, width)}</Text>
      {error && <Text color={color.danger}>{error}</Text>}
      {!lines && !error && <Text dimColor>Loading…</Text>}
      {lines?.slice(top, top + page).map((line, index) => (
        <Text
          key={top + index}
          wrap="truncate-end"
          {...(line.kind === 'add' ? { color: color.success } : line.kind === 'del' ? { color: color.danger } : {})}
          dimColor={line.kind === 'hunk' || line.kind === 'same'}
        >
          {line.text || ' '}
        </Text>
      ))}
      <Text dimColor>{lines && lines.length > page ? `${top + 1}–${Math.min(lines.length, top + page)} of ${lines.length} · ↑↓ scroll · space page · ` : ''}esc back</Text>
    </Box>
  )
}

// --- help --------------------------------------------------------------------

export function HelpView({ commands, onClose, width }: { commands: readonly CommandSpec[]; onClose: () => void; width: number }) {
  useClose(onClose)
  const keys: Array<[string, string]> = [
    ['Enter', 'Send; while it runs, queue for after the run'],
    ['Tab, Alt+Enter', 'While it runs, steer now (empty box: the queue)'],
    ['Shift/Alt+Enter, Ctrl+J', 'New line (or end the line with \\)'],
    ['Esc', 'Stop the run'],
    ['Ctrl+O', 'Show or fold every step of the transcript'],
    ['↑ ↓', 'Earlier prompts'],
    ['Ctrl+C', 'Clear the prompt; twice to quit'],
  ]
  return (
    <Frame title="Keys" width={width}>
      {keys.map(([key, text]) => <Text key={key}>  {padEnd(key, 26)}<Text dimColor>{text}</Text></Text>)}
      <Box marginTop={1}><Text bold>Commands</Text></Box>
      {commands.map(command => (
        <Text key={command.name}>  {padEnd(`${command.name}${command.usage ? ` ${command.usage}` : ''}`, 26)}<Text dimColor>{truncate(command.description, Math.max(10, width - 30))}</Text></Text>
      ))}
    </Frame>
  )
}
