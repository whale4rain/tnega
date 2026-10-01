import { ArrowUp, AtSign, FileText, Slash, Sparkles, Square } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { applyCompletion, detectTrigger, rankCommands, type CommandSpec, type Trigger } from '../lib/completion'

/** One argument suggestion for a command, e.g. a model id or a skill name. */
export interface ArgumentSuggestion {
  value: string
  label: string
  detail?: string
}

interface CompletionItem {
  key: string
  label: string
  detail?: string
  icon: ReactNode
  insert: string
}

interface Completion {
  title: string
  items: CompletionItem[]
  loading: boolean
  empty: string
}

const MAX_ITEMS = 12

function triggerKey(trigger: Trigger | undefined): string {
  if (!trigger) return ''
  return trigger.kind === 'argument' ? `${trigger.kind}:${trigger.command}:${trigger.start}` : `${trigger.kind}:${trigger.start}`
}

/**
 * The message box itself: auto-growing input, completion for slash commands, their
 * arguments and `@` file mentions, a toolbar slot and a send / stop button.
 */
export function PromptBox({
  commands = [],
  completeArgument,
  searchFiles,
  running = false,
  disabledReason,
  onSubmit,
  onStop,
  placeholder,
  toolbar,
  footer,
  autoFocusKey,
  compact,
}: {
  commands?: readonly CommandSpec[]
  /** Suggestions for the first argument of `command` (with its slash). */
  completeArgument?: ((command: string, query: string) => Promise<ArgumentSuggestion[]>) | undefined
  /** Workspace files for an `@` mention. */
  searchFiles?: ((query: string) => Promise<string[]>) | undefined
  running?: boolean
  disabledReason?: ReactNode
  onSubmit: (text: string) => Promise<boolean> | boolean
  /** When given, the send button becomes a stop button while `running`. */
  onStop?: (() => void) | undefined
  placeholder: string
  toolbar?: ReactNode
  footer?: ReactNode
  autoFocusKey?: string | undefined
  compact?: boolean
}) {
  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const [active, setActive] = useState(0)
  const [dismissed, setDismissed] = useState('')
  const [asyncItems, setAsyncItems] = useState<{ key: string, items: CompletionItem[] } | undefined>()
  const input = useRef<HTMLTextAreaElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const pendingCaret = useRef<number | undefined>(undefined)
  const showStop = running && Boolean(onStop)

  const maxHeight = compact ? 180 : 280
  const fit = useCallback(() => {
    const el = input.current
    // Without a width (hidden or not laid out yet) the text would wrap per character.
    if (!el || el.clientWidth === 0) return
    el.style.height = '0px'
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
  }, [maxHeight])

  useLayoutEffect(fit, [text, fit])

  // Restore the caret after a completion rewrote the text.
  useLayoutEffect(() => {
    const el = input.current
    if (!el || pendingCaret.current === undefined) return
    el.setSelectionRange(pendingCaret.current, pendingCaret.current)
    pendingCaret.current = undefined
  }, [text])

  // The height depends on width too (wrapping), so refit when the box resizes.
  useEffect(() => {
    const el = input.current
    if (!el) return
    const frame = requestAnimationFrame(fit)
    void document.fonts?.ready.then(fit)
    const parent = el.parentElement
    const observer = typeof ResizeObserver === 'undefined' || !parent ? undefined : new ResizeObserver(fit)
    if (parent) observer?.observe(parent)
    return () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
    }
  }, [fit])

  useEffect(() => {
    input.current?.focus()
  }, [autoFocusKey])

  const trigger = useMemo(() => detectTrigger(text, caret), [text, caret])
  const key = triggerKey(trigger)
  // Escape hides the menu for what is typed now; typing more brings it back.
  const dismissKey = trigger ? `${key}:${trigger.query}` : ''
  const command = trigger?.kind === 'argument' ? commands.find(each => each.name === trigger.command) : undefined
  const wantsArguments = trigger?.kind === 'argument' && Boolean(command?.hasArguments && completeArgument)
  const wantsFiles = trigger?.kind === 'mention' && Boolean(searchFiles)
  const asyncQuery = trigger && (wantsArguments || wantsFiles) ? `${key}:${trigger.query}` : ''
  const asyncKind = wantsFiles ? 'mention' : wantsArguments ? 'argument' : undefined
  const asyncCommand = trigger?.kind === 'argument' ? trigger.command : ''
  const asyncText = trigger?.query ?? ''

  // Arguments and files come from the server; debounce and drop stale answers.
  useEffect(() => {
    if (!asyncQuery || !asyncKind) return
    let cancelled = false
    const timer = setTimeout(() => {
      const load = asyncKind === 'mention'
        ? searchFiles?.(asyncText).then(files => files.map((path): CompletionItem => ({
          key: path,
          label: path,
          icon: <FileText size={14} />,
          insert: `@${path} `,
        })))
        : completeArgument?.(asyncCommand, asyncText).then(suggestions => suggestions.map((suggestion): CompletionItem => ({
          key: suggestion.value,
          label: suggestion.label,
          ...(suggestion.detail ? { detail: suggestion.detail } : {}),
          icon: <Slash size={14} />,
          insert: `${suggestion.value} `,
        })))
      load?.then(items => !cancelled && setAsyncItems({ key: asyncQuery, items: items.slice(0, MAX_ITEMS) }), () => {
        if (!cancelled) setAsyncItems({ key: asyncQuery, items: [] })
      })
    }, asyncKind === 'mention' ? 120 : 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [asyncQuery, asyncKind, asyncCommand, asyncText, searchFiles, completeArgument])

  const completion = useMemo((): Completion | undefined => {
    if (!trigger || dismissKey === dismissed) return undefined
    if (trigger.kind === 'command') {
      if (!commands.length) return undefined
      const items = rankCommands(commands, trigger.query).slice(0, MAX_ITEMS).map((each): CompletionItem => ({
        key: each.name,
        label: each.usage ? `${each.name} ${each.usage}` : each.name,
        detail: each.description,
        icon: <Slash size={14} />,
        insert: `${each.name} `,
      }))
      return { title: 'Commands', items, loading: false, empty: 'No matching commands' }
    }
    if (!wantsArguments && !wantsFiles) return undefined
    const ready = asyncItems?.key === asyncQuery
    return {
      title: trigger.kind === 'mention' ? 'Workspace files' : `${trigger.kind === 'argument' ? trigger.command : ''} options`,
      items: ready ? asyncItems.items : [],
      loading: !ready,
      empty: trigger.kind === 'mention' ? 'No matching files' : 'No suggestions',
    }
  }, [trigger, dismissKey, dismissed, commands, wantsArguments, wantsFiles, asyncItems, asyncQuery])

  useEffect(() => setActive(0), [key, trigger?.query])
  useEffect(() => {
    menu.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const accept = (item: CompletionItem | undefined): boolean => {
    if (!item || !trigger) return false
    const next = applyCompletion(text, trigger, item.insert)
    pendingCaret.current = next.caret
    setText(next.text)
    setCaret(next.caret)
    input.current?.focus()
    return true
  }

  const submit = async () => {
    const value = text.trim()
    if (!value || showStop || disabledReason) return
    const accepted = await onSubmit(value)
    if (accepted) {
      setText('')
      setCaret(0)
      setDismissed('')
    }
  }

  const items = completion?.items ?? []
  const open = Boolean(completion)

  return (
    <div className={`composer${running ? ' is-running' : ''}${compact ? ' compact' : ''}`}>
      {completion && (
        <div className="slash-menu" role="listbox" aria-label={completion.title} ref={menu}>
          <div className="slash-menu-title">
            {trigger?.kind === 'mention' ? <AtSign size={12} /> : <Slash size={12} />}
            <span>{completion.title}</span>
            <span className="slash-menu-keys">↑↓ to choose · Tab to insert · Esc to close</span>
          </div>
          {items.map((item, index) => (
            <button
              key={item.key}
              type="button"
              role="option"
              aria-selected={index === active}
              className={`slash-item${index === active ? ' active' : ''}`}
              onMouseEnter={() => setActive(index)}
              onMouseDown={event => event.preventDefault()}
              onClick={() => accept(item)}
            >
              <span className="slash-icon">{item.icon}</span>
              <span className="slash-name">{item.label}</span>
              {item.detail && <span className="slash-desc">{item.detail}</span>}
            </button>
          ))}
          {items.length === 0 && (
            <div className="slash-empty">{completion.loading ? 'Searching…' : completion.empty}</div>
          )}
        </div>
      )}
      <div className="composer-box" onClick={() => input.current?.focus()}>
        <textarea
          ref={input}
          value={text}
          rows={1}
          placeholder={placeholder}
          aria-label="Message"
          aria-autocomplete="list"
          aria-expanded={open}
          onChange={event => {
            setText(event.target.value)
            setCaret(event.target.selectionStart)
          }}
          onSelect={event => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return
            if (open) {
              if (event.key === 'Escape') {
                event.preventDefault()
                setDismissed(dismissKey)
                return
              }
              if (items.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                event.preventDefault()
                const delta = event.key === 'ArrowDown' ? 1 : -1
                setActive(index => (index + delta + items.length) % items.length)
                return
              }
              const pick = items[active]
              // Enter on a command that is already typed out sends it instead of re-completing.
              const complete = pick && pick.insert.trim() !== text.trim()
              if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && complete)) {
                if (accept(pick)) {
                  event.preventDefault()
                  return
                }
              }
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void submit()
            }
            if (event.key === 'Escape' && showStop) {
              event.preventDefault()
              onStop?.()
            }
          }}
        />
        <div className="composer-toolbar" onClick={event => event.stopPropagation()}>
          <div className="composer-controls">{toolbar}</div>
          {showStop
            ? (
              <button type="button" className="send-button stop" onClick={onStop} aria-label="Stop" title="Stop (Esc)">
                <Square size={13} fill="currentColor" />
              </button>
            )
            : (
              <button
                type="button"
                className="send-button"
                onClick={() => void submit()}
                disabled={!text.trim() || Boolean(disabledReason)}
                aria-label="Send"
                title="Send (Enter)"
              >
                <ArrowUp size={17} strokeWidth={2.4} />
              </button>
            )}
        </div>
      </div>
      {!compact && (disabledReason || footer) && (
        <div className="composer-footer">
          {disabledReason ? <span className="composer-warning"><Sparkles size={13} />{disabledReason}</span> : footer}
        </div>
      )}
    </div>
  )
}
