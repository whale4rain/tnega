/**
 * The terminal UI. Layout, top to bottom: the scrollback (a banner, then
 * every finished entry, printed once with `<Static>` so long transcripts
 * cost nothing to redraw), the running turn, what is waiting on you, any
 * queued messages, the composer with a row of key hints, and one status line
 * with the weather.
 */
import {
  applyCompletion,
  detectTrigger,
  formatCost,
  parseCommand,
  presentRun,
  rankCommands,
  turnWeather,
  WEATHER_LABEL,
  type CommandSpec,
  type Entry,
  type Trigger,
  type Weather,
} from '@tnega/client'
import { Box, Static, Text, useApp, useInput, useStdout, useWindowSize, type DOMElement } from 'ink'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Composer } from './composer.js'
import { TUI_COMMANDS, type TuiController, type TuiState } from './controller.js'
import { EMPTY, History, type EditorState } from './editor.js'
import { KeyHints, KeySheet } from './hints.js'
import { Picker, type PickerItem } from './picker.js'
import { ApprovalPanel, QuestionPanel } from './prompts.js'
import { Spinner } from './spinner.js'
import { color, glyph, tint, weatherColor, weatherMark, weatherSpins } from './theme.js'
import { AgentTurn, EntryView } from './transcript.js'
import { ChangesView, HelpView, SettingsView, UsageView } from './views.js'
import { padEnd, stringWidth, truncate } from './width.js'

type Overlay = 'sessions' | 'models' | 'usage' | 'settings' | 'changes' | 'help'

/** Entries printed when a session opens; older ones stay in the web app. */
const HISTORY_LIMIT = 80

export interface AppProps {
  controller: TuiController
  /** Where the web app is served, for `/web`. */
  webUrl: string
  /** Open a URL in the system browser; returns false when nothing could. */
  openUrl: (url: string) => boolean
  /** The terminal reports Shift+Enter apart from Enter (kitty keyboard protocol). */
  shiftEnter?: boolean
}

type StaticItem =
  | { key: string; kind: 'banner'; hidden: number }
  | { key: string; kind: 'entry'; entry: Entry }

export function App({ controller, webUrl, openUrl, shiftEnter = false }: AppProps) {
  const state = useSyncExternalStore(
    useCallback(listener => controller.subscribe(listener), [controller]),
    () => controller.state,
  )
  const { exit } = useApp()
  const { stdout } = useStdout()
  const { columns, rows } = useWindowSize()
  const width = Math.max(30, columns)
  const [editor, setEditor] = useState<EditorState>(EMPTY)
  const [overlay, setOverlay] = useState<Overlay>()
  const [verbose, setVerbose] = useState(false)
  const [quitArmed, setQuitArmed] = useState(false)
  const [showKeys, setShowKeys] = useState(false)
  const history = useRef(new History())
  const composerBox = useRef<DOMElement>(null)

  // --- the scrollback ----------------------------------------------------------

  // A replaced transcript (another session, a compaction, Ctrl+O) is redrawn
  // from a clean screen: what <Static> printed cannot be taken back otherwise.
  const viewKey = `${state.epoch}:${verbose ? 'v' : 'f'}`
  const shownKey = useRef(viewKey)
  const offset = useRef({ key: '', value: 0 })
  if (shownKey.current !== viewKey) {
    shownKey.current = viewKey
    stdout.write('\u001B[2J\u001B[3J\u001B[H')
  }
  if (offset.current.key !== viewKey) {
    offset.current = { key: viewKey, value: Math.max(0, state.entries.length - HISTORY_LIMIT) }
  }
  const liveIndex = liveEntryIndex(state)
  const committed = liveIndex === undefined ? state.entries : state.entries.slice(0, liveIndex)
  const items: StaticItem[] = [
    { key: `banner-${viewKey}`, kind: 'banner', hidden: offset.current.value },
    ...committed.slice(offset.current.value).map((entry, index): StaticItem => ({ key: `${viewKey}-${index}-${entry.id}`, kind: 'entry', entry })),
  ]
  const liveEntry = liveIndex === undefined ? undefined : state.entries[liveIndex]

  // --- completion --------------------------------------------------------------

  const commands = useMemo(() => uniqueCommands([...controller.commands, ...TUI_COMMANDS]), [controller, state.serverCommands])
  const [dismissed, setDismissed] = useState<string>()
  const [selection, setSelection] = useState(0)
  const [mentions, setMentions] = useState<{ query: string; files: string[] }>({ query: '', files: [] })
  const trigger = dismissed === editor.text ? undefined : detectTrigger(editor.text, editor.caret)
  const suggestions = suggestionsFor(trigger, commands, state, mentions)
  useEffect(() => {
    if (trigger?.kind !== 'mention') return
    const controllerAbort = new AbortController()
    const timer = setTimeout(() => {
      controller.api.searchFiles(state.workspace, trigger.query, controllerAbort.signal)
        .then(result => setMentions({ query: trigger.query, files: result.files }), () => undefined)
    }, 120)
    return () => {
      clearTimeout(timer)
      controllerAbort.abort()
    }
  }, [trigger?.kind, trigger?.query, controller, state.workspace])
  useEffect(() => setSelection(0), [trigger?.kind, trigger?.query])
  const completing = suggestions.length > 0
  const accept = (submitNow: boolean) => {
    const choice = suggestions[Math.min(selection, suggestions.length - 1)]
    if (!choice || !trigger) return
    if (submitNow && choice.runs) return submit(choice.runs)
    const next = applyCompletion(editor.text, trigger, choice.insert)
    // Already complete: Enter sends it.
    if (submitNow && next.text.trimEnd() === editor.text.trimEnd()) return submit(editor.text)
    setEditor({ text: next.text, caret: next.caret })
  }

  // --- actions -----------------------------------------------------------------

  const waiting = state.approvals.length > 0 || state.questions.length > 0
  const live = state.running || state.remoteRunning

  const submit = (text: string) => {
    history.current.push(text)
    setEditor(EMPTY)
    setQuitArmed(false)
    const parsed = parseCommand(text)
    if (parsed && !live && runViewCommand(parsed.name, parsed.rest)) return
    void controller.send(text).then(ok => {
      if (!ok) setEditor(current => current.text ? current : { text, caret: text.length })
    })
  }

  const runViewCommand = (name: string, rest: string): boolean => {
    switch (name) {
      case '/new':
        controller.newSession()
        return true
      case '/sessions':
      case '/resume':
        void controller.refreshSessions()
        setOverlay('sessions')
        return true
      case '/model':
        if (rest) return false
        setOverlay('models')
        return true
      case '/usage':
        setOverlay('usage')
        return true
      case '/diff':
      case '/changes':
        setOverlay('changes')
        return true
      case '/settings':
      case '/config':
        setOverlay('settings')
        return true
      case '/help':
        setOverlay('help')
        return true
      case '/quit':
      case '/exit':
        exit()
        return true
      case '/web': {
        const url = `${webUrl}/${state.session ? `#${state.session.id}` : ''}`
        if (openUrl(url)) controller.info(`Opened ${url}. It works while this TUI runs.`)
        else controller.info(`Open ${url} in a browser. It works while this TUI runs.`)
        return true
      }
      default:
        return false
    }
  }

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      if (editor.text) {
        setEditor(EMPTY)
        return
      }
      if (quitArmed) return exit()
      setQuitArmed(true)
      controller.info('Press Ctrl+C again to quit.')
      return
    }
    if (key.ctrl && input === 'd' && !editor.text) return exit()
    if (key.ctrl && input === 'o') return setVerbose(value => !value)
    if (key.ctrl && input === 'x' && state.queued.length) {
      controller.unqueue()
      return
    }
    if (key.escape && showKeys) return setShowKeys(false)
    if (key.escape && !completing && !overlay && !waiting) {
      if (live) void controller.stop()
      else controller.clearNotice()
    }
  })

  useEffect(() => {
    if (!quitArmed) return
    const timer = setTimeout(() => setQuitArmed(false), 2000)
    return () => clearTimeout(timer)
  }, [quitArmed])

  // A brief "Done" after a run, as the web's rainbow.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!state.finishedAt) return
    const timer = setTimeout(() => setTick(tick => tick + 1), 3100)
    return () => clearTimeout(timer)
  }, [state.finishedAt])

  // --- layout ------------------------------------------------------------------

  const composerRows = editor.text.split('\n').length + 2
  const reserved = composerRows + 5 + state.queued.length + (state.notice ? 1 : 0) + (state.busy ? 1 : 0) + (completing ? Math.min(6, suggestions.length) : 0)
  const liveRows = Math.max(4, rows - reserved - 2)
  const overlayRows = Math.max(5, rows - 6)
  const approval = state.approvals[0]
  const question = state.questions[0]

  return (
    <Box flexDirection="column" width={width}>
      <Static key={viewKey} items={items}>
        {item => item.kind === 'banner'
          ? <Banner key={item.key} state={state} hidden={item.hidden} width={width} />
          : <EntryView key={item.key} entry={item.entry} width={width} verbose={verbose} />}
      </Static>
      {liveEntry?.kind === 'agent' && <AgentTurn entry={liveEntry} width={width} verbose={verbose} live maxRows={liveRows} />}
      {state.plan && state.plan.items.length > 0 && live && <PlanLine plan={state.plan} width={width} />}
      {state.busy && <Text dimColor><Spinner /> {state.busy}</Text>}
      {approval
        ? <ApprovalPanel key={approval.id} approval={approval} more={state.approvals.length - 1} onAnswer={allow => void controller.approve(approval, allow)} width={width} />
        : question
          ? <QuestionPanel key={question.requestId} request={question} onAnswer={answers => void controller.answer(question, answers)} width={width} />
          : overlay
            ? <OverlayView overlay={overlay} controller={controller} state={state} width={width} rows={overlayRows} onClose={() => setOverlay(undefined)} />
            : (
                <Box ref={composerBox} flexDirection="column" marginTop={1}>
                  <QueuedRows queued={state.queued} width={width} />
                  <Composer
                    value={editor}
                    onChange={next => {
                      setEditor(next)
                      if (dismissed !== undefined && dismissed !== next.text) setDismissed(undefined)
                    }}
                    onSubmit={submit}
                    onHistory={(direction, current) => {
                      // Up on an empty box takes a queued message back first.
                      if (direction < 0 && !current && state.queued.length) return controller.unqueue()
                      return direction < 0 ? history.current.previous(current) : history.current.next()
                    }}
                    active={!state.busy}
                    placeholder={live ? 'Steer the agent' : state.session ? 'Reply…' : 'Ask tnega to do something'}
                    width={width}
                    origin={composerBox}
                    label={composerLabel(editor, controller.settings.mode)}
                    keys={{
                      completing,
                      onCompletionMove: delta => setSelection(index => Math.max(0, Math.min(suggestions.length - 1, index + delta))),
                      onCompletionAccept: accept,
                      onCompletionClose: () => setDismissed(editor.text),
                      onQueue: state.running ? text => void controller.enqueue(text) : undefined,
                      onCycleMode: () => void controller.cycleMode(),
                      onEmptyKey: input => {
                        if (input !== '?') return false
                        setShowKeys(value => !value)
                        return true
                      },
                      onSubmitEmpty: () => void controller.sendQueued(),
                    }}
                  />
                  {completing && <Suggestions items={suggestions} selected={selection} width={width} />}
                  {showKeys && !editor.text
                    ? <KeySheet shiftEnter={shiftEnter} width={width} />
                    : (
                        <KeyHints
                          width={width}
                          context={{ completing, live, empty: !editor.text, shiftEnter, verbose, foldedSteps: foldedSteps(state.entries) }}
                        />
                      )}
                </Box>
              )}
      {state.notice && <Text {...tint(state.notice.tone === 'error' ? color.danger : state.notice.tone === 'warn' ? color.warn : undefined)} dimColor={state.notice.tone === 'info'}>{truncate(state.notice.text, width * 3)}</Text>}
      <StatusLine state={state} controller={controller} width={width} />
    </Box>
  )
}

/** Index of the entry still being written, which stays out of the scrollback. */
function liveEntryIndex(state: TuiState): number | undefined {
  if (!state.running && !state.remoteRunning) return undefined
  const index = state.entries.length - 1
  return state.entries[index]?.kind === 'agent' ? index : undefined
}

function Banner({ state, hidden, width }: { state: TuiState; hidden: number; width: number }) {
  return (
    <Box flexDirection="column" width={width}>
      <Text>
        <Text bold>tnega</Text>
        <Text dimColor>  {truncate(state.workspace, Math.max(10, width - 8))}</Text>
      </Text>
      <Text dimColor>{state.session ? truncate(state.session.title || 'Untitled session', width) : 'New session · /help for keys and commands'}</Text>
      {hidden > 0 && <Text dimColor>{hidden} earlier entries are not shown here; /web shows the whole session.</Text>}
    </Box>
  )
}

function PlanLine({ plan, width }: { plan: NonNullable<TuiState['plan']>; width: number }) {
  const done = plan.items.filter(item => item.status === 'done').length
  const current = plan.items.find(item => item.status === 'pending')
  return (
    <Text dimColor>
      Plan {done}/{plan.items.length}{current ? ` · ${truncate(current.title, width - 16)}` : ''}
    </Text>
  )
}

function StatusLine({ state, controller, width }: { state: TuiState; controller: TuiController; width: number }) {
  const weather = currentWeather(state)
  const settings = controller.settings
  const model = controller.model
  const mark = weatherSpins(weather) ? <Spinner color={weatherColor(weather)} /> : <Text {...(weatherColor(weather) ? { color: weatherColor(weather)! } : { dimColor: true })}>{weatherMark(weather)}</Text>
  const ratio = state.context && state.context.limit > 0 ? state.context.ratio : undefined
  const cost = formatCost(state.usage?.cost)
  const right = [ratio !== undefined ? `${Math.round(ratio * 100)}% context` : undefined, cost].filter(Boolean).join(` ${glyph.bullet} `)
  const mode = settings.mode !== 'auto' ? settings.mode : undefined
  const left = [model?.name, settings.agentType, mode, settings.permission, settings.approvalMode === 'auto' ? 'auto-approve' : undefined]
    .filter(Boolean).join(` ${glyph.bullet} `)
  const shown = truncate(left, Math.max(10, width - 20 - right.length))
  // A non-default mode changes what Enter does, so it stands out from the rest.
  const modeAt = mode ? shown.indexOf(` ${glyph.bullet} ${mode}`) : -1
  return (
    <Box width={width} justifyContent="space-between">
      <Text>
        {mark} <Text {...(weatherColor(weather) ? { color: weatherColor(weather)! } : {})}>{WEATHER_LABEL[weather]}</Text>
        {modeAt < 0
          ? <Text dimColor>  {shown}</Text>
          : (
              <>
                <Text dimColor>  {shown.slice(0, modeAt + 3)}</Text>
                <Text bold>{mode}</Text>
                <Text dimColor>{shown.slice(modeAt + 3 + (mode ?? '').length)}</Text>
              </>
            )}
      </Text>
      <Text dimColor>{right}</Text>
    </Box>
  )
}

export function currentWeather(state: TuiState): Weather {
  const live = state.running || state.remoteRunning
  const waiting = state.approvals.length > 0 || state.questions.length > 0
  const last = [...state.entries].reverse().find((entry): entry is Extract<Entry, { kind: 'agent' }> => entry.kind === 'agent')
  if (!last) return waiting ? 'snow' : live ? 'cloudy' : 'clear'
  const justFinished = state.finishedAt !== undefined && Date.now() - state.finishedAt < 3000
  return turnWeather(last, {
    live,
    waiting,
    ...(state.context ? { contextRatio: state.context.ratio } : {}),
    justFinished,
  })
}

// --- overlays ------------------------------------------------------------------

function OverlayView({ overlay, controller, state, width, rows, onClose }: {
  overlay: Overlay
  controller: TuiController
  state: TuiState
  width: number
  rows: number
  onClose: () => void
}) {
  const api = controller.api
  switch (overlay) {
    case 'sessions': {
      const items: PickerItem[] = [
        { key: '', label: 'New session' },
        ...state.sessions.map(session => ({
          key: session.id,
          label: session.title || 'Untitled session',
          detail: relativeTime(session.updatedAt),
          ...(session.id === state.session?.id ? { current: true } : {}),
        })),
      ]
      return (
        <Picker
          title="Sessions in this folder"
          items={items}
          width={width}
          rows={rows - 3}
          onClose={onClose}
          onPick={item => {
            onClose()
            if (item.key) void controller.openSession(item.key)
            else controller.newSession()
          }}
        />
      )
    }
    case 'models': {
      const models = state.config?.models ?? []
      const current = controller.model?.id
      return (
        <Picker
          title="Model"
          items={models.map(model => ({
            key: model.id,
            label: model.name || model.id,
            detail: [model.id !== model.name ? model.id : '', model.apiKeySet ? '' : 'no key'].filter(Boolean).join(' · '),
            ...(model.id === current ? { current: true } : {}),
          }))}
          empty="No models are set up. Add one in the web app (/web)."
          width={width}
          rows={rows - 3}
          onClose={onClose}
          onPick={item => {
            onClose()
            void controller.changeSettings({ model: item.key })
          }}
        />
      )
    }
    case 'usage':
      return <UsageView api={api} workspace={state.workspace} onClose={onClose} width={width} />
    case 'settings':
      return <SettingsView config={state.config} settings={controller.settings} sessionOpen={Boolean(state.session)} onChange={patch => void controller.changeSettings(patch)} onClose={onClose} width={width} />
    case 'changes':
      return <ChangesView api={api} workspace={state.workspace} onClose={onClose} width={width} rows={rows} />
    case 'help':
      return <HelpView commands={uniqueCommands([...controller.commands, ...TUI_COMMANDS]).slice(0, Math.max(4, rows - 12))} onClose={onClose} width={width} />
  }
}

// --- completion ----------------------------------------------------------------

interface Suggestion {
  key: string
  label: string
  detail?: string
  insert: string
  /** Enter sends this at once: a command whose arguments are optional. */
  runs?: string
}

function suggestionsFor(trigger: Trigger | undefined, commands: readonly CommandSpec[], state: TuiState, mentions: { query: string; files: string[] }): Suggestion[] {
  if (!trigger) return []
  if (trigger.kind === 'command') {
    return rankCommands(commands, trigger.query).slice(0, 6).map(command => ({
      key: command.name,
      label: `${command.name}${command.usage ? ` ${command.usage}` : ''}`,
      detail: command.description,
      insert: `${command.name} `,
      ...(!command.usage?.startsWith('<') && command.source === 'client' ? { runs: command.name } : {}),
    }))
  }
  if (trigger.kind === 'argument') {
    if (trigger.command === '/model') {
      const needle = trigger.query.toLowerCase()
      return (state.config?.models ?? [])
        .filter(model => !needle || model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle))
        .slice(0, 6)
        .map(model => ({ key: model.id, label: model.name || model.id, detail: model.id, insert: model.id }))
    }
    if (trigger.command === '/codemode') {
      return ['on', 'off'].filter(value => value.startsWith(trigger.query.toLowerCase())).map(value => ({ key: value, label: value, insert: value }))
    }
    return []
  }
  if (mentions.query !== trigger.query) return []
  return mentions.files.slice(0, 6).map(file => ({ key: file, label: file, insert: `@${file} ` }))
}

function Suggestions({ items, selected, width }: { items: readonly Suggestion[]; selected: number; width: number }) {
  const column = Math.min(Math.floor(width / 2), Math.max(...items.map(item => stringWidth(item.label))) + 2)
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {items.map((item, index) => (
        <Text key={item.key} inverse={index === selected}>
          {padEnd(truncate(item.label, column - 2), column)}
          {item.detail ? <Text dimColor={index !== selected}>{truncate(item.detail, Math.max(0, width - column - 4))}</Text> : null}
        </Text>
      ))}
    </Box>
  )
}

/** The composer's border label: the line count and a non-default mode. */
export function composerLabel(editor: EditorState, mode: string): string | undefined {
  const lines = editor.text ? editor.text.split('\n').length : 1
  const parts = [lines > 1 ? `${lines} lines` : undefined, mode !== 'auto' ? mode : undefined].filter(Boolean)
  return parts.length ? parts.join(` ${glyph.bullet} `) : undefined
}

/** Tool steps folded away in the last finished turn, for the Ctrl+O hint. */
export function foldedSteps(entries: readonly Entry[]): number {
  const last = entries.findLast(entry => entry.kind === 'agent')
  if (last?.kind !== 'agent' || last.status === 'running') return 0
  // Counted as the transcript counts its "Used N tools" line.
  return presentRun(last).process.filter(block => block.kind === 'tool' || block.kind === 'subagent').length
}

/** Messages waiting for the run to end, newest last, with how to change them. */
function QueuedRows({ queued, width }: { queued: readonly string[]; width: number }) {
  if (!queued.length) return null
  const actions = `↑ edit ${glyph.bullet} ctrl+x drop`
  return (
    <Box flexDirection="column" marginBottom={1}>
      {queued.map((text, index) => {
        const last = index === queued.length - 1
        const room = width - 12 - (last ? stringWidth(actions) + 2 : 0)
        return (
          <Box key={index} width={width} justifyContent="space-between">
            <Text>
              <Text dimColor>{'  '}queued  </Text>
              {truncate(text.replace(/\s+/g, ' '), Math.max(8, room))}
            </Text>
            {last ? <Text dimColor>{actions}</Text> : null}
          </Box>
        )
      })}
    </Box>
  )
}

function uniqueCommands(commands: readonly CommandSpec[]): CommandSpec[] {
  const seen = new Set<string>()
  return commands.filter(command => !seen.has(command.name) && Boolean(seen.add(command.name)))
}

function relativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return days < 30 ? `${days}d ago` : new Date(timestamp).toLocaleDateString()
}
