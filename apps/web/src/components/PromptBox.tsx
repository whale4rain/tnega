import { ArrowUp, AtSign, FileText, ImagePlus, Paperclip, Slash, Sparkles, SquareMousePointer, Square, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { attachedFileLine, droppedFiles, MAX_FILES_PER_MESSAGE, sortDropped } from '../lib/attached-files'
import { imageFromFile, imageSrc, MAX_IMAGES_PER_MESSAGE } from '../lib/attachments'
import { COMPOSER_INSERT, type ComposerContext, type ComposerInsert } from '../lib/browser-live'
import { applyCompletion, detectTrigger, rankCommands, type CommandSpec, type Trigger } from '../lib/completion'
import { errorText } from '../lib/hooks'
import { continueList, indentList, markdownTokens, type InputEdit } from '../lib/markdown-input'
import type { ImageAttachment } from '../lib/types'

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

/** A dropped file on its way into the workspace, then the path it was saved at. */
interface AttachedFile {
  key: number
  name: string
  path?: string
  error?: string
}

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
  allowWhileRunning = false,
  disabledReason,
  onSubmit,
  onInterruptSubmit,
  onSteerSubmit,
  onStop,
  placeholder,
  toolbar,
  footer,
  autoFocusKey,
  resetKey,
  compact,
  inline,
  acceptImages = false,
  imageNotice,
  attachFile,
}: {
  commands?: readonly CommandSpec[]
  /** Suggestions for the first argument of `command` (with its slash). */
  completeArgument?: ((command: string, query: string) => Promise<ArgumentSuggestion[]>) | undefined
  /** Workspace files for an `@` mention. */
  searchFiles?: ((query: string) => Promise<string[]>) | undefined
  running?: boolean
  /** Keep sending asynchronous messages alongside a separate stop control. */
  allowWhileRunning?: boolean
  disabledReason?: ReactNode
  onSubmit: (text: string, images: ImageAttachment[]) => Promise<boolean> | boolean
  /** Stop the current run; replaces Send unless `allowWhileRunning` is enabled. */
  onStop?: (() => void) | undefined
  /** Stop the current run and send a correction, offered separately while running. */
  onInterruptSubmit?: ((text: string, images: ImageAttachment[]) => Promise<boolean> | boolean) | undefined
  /** While running, Ctrl/Cmd+Enter hands the message to the running agent now instead of `onSubmit`. */
  onSteerSubmit?: ((text: string, images: ImageAttachment[]) => Promise<boolean> | boolean) | undefined
  placeholder: string
  toolbar?: ReactNode
  footer?: ReactNode
  autoFocusKey?: string | undefined
  /** A draft belongs to the conversation it was typed in: a new key starts empty. */
  resetKey?: string | undefined
  compact?: boolean
  /** One line at rest with the send button beside the text; grows as you type. Project room and threads. */
  inline?: boolean
  /** Allow pasting, dropping or picking images to send with the message. */
  acceptImages?: boolean
  /** Shown under attached images, e.g. when the model cannot see them. */
  imageNotice?: ReactNode
  /**
   * Save a dropped, pasted or picked file (a document, notes, data) into the
   * workspace and return its path; the message then names that path. Without
   * it only images are accepted.
   */
  attachFile?: ((file: File) => Promise<string>) | undefined
}) {
  const [text, setText] = useState('')
  const [images, setImages] = useState<ImageAttachment[]>([])
  const [contexts, setContexts] = useState<ComposerContext[]>([])
  const [files, setFiles] = useState<AttachedFile[]>([])
  const fileKey = useRef(0)
  const [reading, setReading] = useState(0)
  const [dragging, setDragging] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const [caret, setCaret] = useState(0)
  const [active, setActive] = useState(0)
  const [dismissed, setDismissed] = useState('')
  const [asyncItems, setAsyncItems] = useState<{ key: string, items: CompletionItem[] } | undefined>()
  const input = useRef<HTMLTextAreaElement>(null)
  const highlight = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const pendingCaret = useRef<number | undefined>(undefined)
  const showStop = running && Boolean(onStop)
  const singleControl = inline && allowWhileRunning && Boolean(onStop)
  const hasContent = Boolean(text.trim() || images.length || contexts.length || files.length)
  const acceptsFiles = acceptImages || Boolean(attachFile)

  const maxHeight = compact || inline ? 180 : 280
  /**
   * The highlight layer sits under the textarea and must wrap exactly like
   * it: same font, padding and text width (the textarea's scrollbar takes
   * some), scrolled to the same place. Its height follows the box in CSS, so
   * it keeps up while the textarea's height animates.
   */
  const mirror = useCallback(() => {
    const el = input.current
    const layer = highlight.current
    if (!el || !layer) return
    const style = getComputedStyle(el)
    layer.style.font = style.font
    layer.style.letterSpacing = style.letterSpacing
    layer.style.padding = style.padding
    layer.style.width = `${el.clientWidth}px`
    layer.scrollTop = el.scrollTop
  }, [])
  const fit = useCallback(() => {
    const el = input.current
    // Without a width (hidden or not laid out yet) the text would wrap per character.
    if (!el || el.clientWidth === 0) return
    el.style.height = '0px'
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
    mirror()
  }, [maxHeight, mirror])

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

  // Unsent text belongs to the session, project or thread it was typed in: leaving it clears the draft.
  useEffect(() => {
    setText('')
    setImages([])
    setContexts([])
    setFiles([])
    setCaret(0)
    setDismissed('')
    setAsyncItems(undefined)
  }, [resetKey])

  // Things handed over from elsewhere in the app, e.g. an element picked in the browser.
  useEffect(() => {
    if (!acceptImages) return
    const onInsert = (event: Event) => {
      if (!(event instanceof CustomEvent)) return
      const detail: ComposerInsert = event.detail ?? {}
      if (detail.context) setContexts(current => [...current, detail.context!])
      if (detail.images?.length) setImages(current => [...current, ...(detail.images ?? [])].slice(0, MAX_IMAGES_PER_MESSAGE))
      if (detail.text) {
        const block = detail.text
        setText(current => current.trim() ? `${current.trimEnd()}\n\n${block}\n\n` : `${block}\n\n`)
      }
      requestAnimationFrame(() => {
        const el = input.current
        if (!el) return
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
      })
    }
    window.addEventListener(COMPOSER_INSERT, onInsert)
    return () => window.removeEventListener(COMPOSER_INSERT, onInsert)
  }, [acceptImages])

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

  /** Applies a markdown list edit as one step, the caret where the edit says. */
  const applyEdit = (edit: InputEdit) => {
    pendingCaret.current = edit.caret
    setText(edit.text)
    setCaret(edit.caret)
  }
  const tokens = useMemo(() => markdownTokens(text), [text])

  const accept = (item: CompletionItem | undefined): boolean => {
    if (!item || !trigger) return false
    const next = applyCompletion(text, trigger, item.insert)
    pendingCaret.current = next.caret
    setText(next.text)
    setCaret(next.caret)
    input.current?.focus()
    return true
  }

  const addImages = async (files: readonly File[]) => {
    if (!acceptImages || !files.length) return
    setReading(count => count + 1)
    try {
      const read = (await Promise.all(files.map(file => imageFromFile(file).catch(() => undefined))))
        .filter((image): image is ImageAttachment => Boolean(image))
      setImages(current => [...current, ...read].slice(0, MAX_IMAGES_PER_MESSAGE))
    } finally {
      setReading(count => count - 1)
    }
  }

  /**
   * Take what was dropped, pasted or picked: images go in as images, other
   * files are saved into the workspace. False when nothing could be taken.
   */
  const addFiles = (incoming: readonly File[]): boolean => {
    const { images: pictures, others } = sortDropped(incoming, acceptImages)
    if (pictures.length) void addImages(pictures)
    if (!attachFile || !others.length) return pictures.length > 0
    const batch = others.slice(0, Math.max(0, MAX_FILES_PER_MESSAGE - files.length))
      .map(file => ({ key: fileKey.current++, name: file.name || 'file', file }))
    setFiles(current => [...current, ...batch.map(({ key, name }) => ({ key, name }))])
    const settle = (key: number, patch: Partial<AttachedFile>) =>
      setFiles(current => current.map(each => (each.key === key ? { ...each, ...patch } : each)))
    for (const item of batch) {
      attachFile(item.file).then(
        path => settle(item.key, { path }),
        (reason: unknown) => settle(item.key, { error: errorText(reason) }),
      )
    }
    return true
  }

  const attached = files.flatMap(file => (file.path ? [file.path] : []))
  const saving = files.some(file => !file.path && !file.error)
  const canSend = (Boolean(text.trim()) || images.length > 0 || contexts.length > 0 || attached.length > 0) && reading === 0 && !saving

  const submit = async (how: 'send' | 'interrupt' | 'steer' = 'send') => {
    const value = [
      ...contexts.map(context => context.text),
      attached.map(attachedFileLine).join('\n'),
      text.trim(),
    ].filter(Boolean).join('\n\n')
    if (!canSend || (showStop && !allowWhileRunning) || disabledReason) return
    const send = how === 'interrupt' ? onInterruptSubmit : how === 'steer' ? onSteerSubmit : onSubmit
    if (!send) return
    const accepted = await send(value, images)
    if (accepted) {
      setText('')
      setImages([])
      setContexts([])
      setFiles([])
      setCaret(0)
      setDismissed('')
    }
  }

  const items = completion?.items ?? []
  const open = Boolean(completion)

  return (
    <div className={`composer${running ? ' is-running' : ''}${compact ? ' compact' : ''}${inline ? ' inline' : ''}`}>
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
      <div
        className={`composer-box${dragging ? ' is-dropping' : ''}`}
        onClick={() => input.current?.focus()}
        onDragOver={event => {
          if (!acceptsFiles || !Array.from(event.dataTransfer.types).includes('Files')) return
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={event => {
          if (!acceptsFiles) return
          const dropped = droppedFiles(event.dataTransfer)
          setDragging(false)
          if (!dropped.length) return
          // A file dropped here never opens in the window instead, even one the box cannot take.
          event.preventDefault()
          addFiles(dropped)
        }}
      >
        {(images.length > 0 || reading > 0 || contexts.length > 0 || files.length > 0) && (
          <div className="composer-attachments" onClick={event => event.stopPropagation()}>
            {contexts.map((context, index) => (
              <span className="composer-context" key={`${index}-${context.label}`} title={context.text}>
                <SquareMousePointer size={12} aria-hidden />
                <span className="composer-context-label">{context.label}</span>
                <button type="button" aria-label={`Remove ${context.label}`} onClick={() => setContexts(current => current.filter((_, at) => at !== index))}>
                  <X size={12} strokeWidth={2.6} />
                </button>
              </span>
            ))}
            {images.map((image, index) => (
              <div className="composer-thumb" key={`${index}-${image.data.length}`}>
                <img src={imageSrc(image)} alt={image.name ?? `Image ${index + 1}`} />
                <button
                  type="button"
                  className="composer-thumb-remove"
                  aria-label={`Remove ${image.name ?? `image ${index + 1}`}`}
                  onClick={() => setImages(current => current.filter((_, at) => at !== index))}
                >
                  <X size={12} strokeWidth={2.6} />
                </button>
              </div>
            ))}
            {files.map(file => (
              <span
                className={`composer-context composer-file${file.error ? ' is-error' : ''}`}
                key={file.key}
                title={file.error ? `Couldn't attach ${file.name}: ${file.error}` : file.path ?? `Attaching ${file.name}…`}
              >
                {file.path || file.error
                  ? <FileText size={12} aria-hidden />
                  : <span className="spinner tiny" role="status" aria-label={`Attaching ${file.name}`} />}
                <span className="composer-context-label">{file.error ? `${file.name} · not attached` : file.name}</span>
                <button type="button" aria-label={`Remove ${file.name}`} onClick={() => setFiles(current => current.filter(each => each.key !== file.key))}>
                  <X size={12} strokeWidth={2.6} />
                </button>
              </span>
            ))}
            {reading > 0 && <div className="composer-thumb is-loading" aria-label="Reading image" />}
            {imageNotice && images.length > 0 && <span className="composer-attachment-note">{imageNotice}</span>}
          </div>
        )}
        <div className="composer-input">
        <div className="composer-highlight" ref={highlight} aria-hidden>
          {tokens.map((token, index) => token.kind
            ? <span key={index} className={`md-${token.kind}`}>{token.text}</span>
            : token.text)}
          {/* A trailing newline needs a character after it to take up its line. */}
          {text.endsWith('\n') ? ' ' : null}
        </div>
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
          onScroll={mirror}
          onPaste={event => {
            if (!acceptsFiles) return
            const pasted = droppedFiles(event.clipboardData)
            if (pasted.length && addFiles(pasted)) event.preventDefault()
          }}
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
            const el = event.currentTarget
            // Markdown lists: Shift+Enter carries the list on, Tab nests an item and Shift+Tab lifts it.
            if (event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
              const edit = continueList(text, el.selectionStart, el.selectionEnd)
              if (edit) {
                event.preventDefault()
                applyEdit(edit)
                return
              }
            }
            if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
              const edit = indentList(text, el.selectionStart, el.selectionEnd, event.shiftKey)
              if (edit) {
                event.preventDefault()
                applyEdit(edit)
                return
              }
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              const urgent = running && (event.ctrlKey || event.metaKey)
              void submit(urgent && singleControl && onInterruptSubmit ? 'interrupt' : urgent && onSteerSubmit ? 'steer' : 'send')
            }
            if (event.key === 'Escape' && showStop) {
              event.preventDefault()
              onStop?.()
            }
          }}
        />
        </div>
        <div className="composer-toolbar" onClick={event => event.stopPropagation()}>
          <div className="composer-controls">
            {acceptsFiles && (
              <>
                <button
                  type="button"
                  className="composer-attach"
                  aria-label={attachFile ? 'Attach files' : 'Attach images'}
                  title={attachFile ? 'Attach files or images (or paste / drop them)' : 'Attach images (or paste / drop them)'}
                  disabled={attachFile ? files.length >= MAX_FILES_PER_MESSAGE && images.length >= MAX_IMAGES_PER_MESSAGE : images.length >= MAX_IMAGES_PER_MESSAGE}
                  onClick={() => picker.current?.click()}
                >
                  {attachFile ? <Paperclip size={14} /> : <ImagePlus size={14} />}
                </button>
                <input
                  ref={picker}
                  type="file"
                  {...(attachFile ? {} : { accept: 'image/png,image/jpeg,image/webp,image/gif' })}
                  multiple
                  hidden
                  onChange={event => {
                    const picked = Array.from(event.target.files ?? [])
                    event.target.value = ''
                    addFiles(picked)
                  }}
                />
              </>
            )}
            {toolbar}
            {!singleControl && running && allowWhileRunning && onInterruptSubmit && (
              <button
                type="button"
                className="button ghost small"
                onClick={() => void submit('interrupt')}
                disabled={!canSend || Boolean(disabledReason)}
                title="Stop the current run and send this correction"
              >
                Interrupt and send
              </button>
            )}
          </div>
          {(singleControl ? running && !hasContent : showStop) && (
            <button type="button" className="send-button stop" onClick={onStop} aria-label="Stop" title="Stop (Esc)">
              <Square size={12} fill="currentColor" />
            </button>
          )}
          {(singleControl ? hasContent || !running : !showStop || allowWhileRunning) && (
            <button
              type="button"
              className="send-button"
              onClick={() => void submit()}
              disabled={!canSend || Boolean(disabledReason)}
              aria-label="Send"
              title={singleControl && running && onInterruptSubmit
                ? 'Send (Enter); interrupt and send (Ctrl+Enter)'
                : running && onSteerSubmit ? 'Queue for after this run (Enter); steer now (Ctrl+Enter)' : 'Send (Enter)'}
            >
              <ArrowUp size={14} strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>
      {!compact && !inline && (disabledReason || footer) && (
        <div className="composer-footer">
          {disabledReason ? <span className="composer-warning"><Sparkles size={12} />{disabledReason}</span> : footer}
        </div>
      )}
    </div>
  )
}
