import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { ClipboardPaste, Copy, Eraser, Plus, SquareTerminal, SquareDashedText, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { errorText, useDismiss } from '../../lib/hooks'
import { terminalClipboardKey } from '../../lib/terminal-keys'
import { workbenchApi, type TerminalInfo } from '../../lib/workbench-api'

/**
 * Your own shell in the workspace, on a real PTY. Several terminals can run
 * side by side as chips; each keeps running when you switch tools, and its
 * scrollback is replayed when you come back.
 */
export function TerminalView({ workspace, visible }: { workspace: string; visible: boolean }) {
  const [terminals, setTerminals] = useState<TerminalInfo[]>()
  const [active, setActive] = useState<string>()
  const [error, setError] = useState<string>()
  const creating = useRef(false)

  const create = useCallback(async () => {
    if (creating.current) return
    creating.current = true
    setError(undefined)
    try {
      const terminal = await workbenchApi.createTerminal(workspace, 100, 30)
      setTerminals(list => [...(list ?? []), terminal])
      setActive(terminal.id)
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      creating.current = false
    }
  }, [workspace])

  // The first visit lists this workspace's terminals and opens one if there are none.
  useEffect(() => {
    if (!visible || terminals) return
    let live = true
    workbenchApi.terminals(workspace).then(result => {
      if (!live) return
      setTerminals(result.terminals)
      if (result.terminals.length) setActive(result.terminals.at(-1)!.id)
      else void create()
    }, reason => { if (live) setError(errorText(reason)) })
    return () => { live = false }
  }, [visible, terminals, workspace, create])

  const close = async (id: string) => {
    await workbenchApi.closeTerminal(id).catch(() => undefined)
    setTerminals(list => {
      const next = (list ?? []).filter(item => item.id !== id)
      if (active === id) setActive(next.at(-1)?.id)
      return next
    })
  }

  return (
    <div className="wb-view">
      <div className="wb-toolbar">
        <div className="wb-subtabs" role="tablist" aria-label="Terminals">
          {terminals?.map((terminal, index) => (
            <div key={terminal.id} className={`wb-subtab${terminal.id === active ? ' active' : ''}`} role="tab" aria-selected={terminal.id === active}>
              <button type="button" className="wb-subtab-main" onClick={() => setActive(terminal.id)}>
                <SquareTerminal size={12} aria-hidden />
                <span>{terminal.title} {index + 1}</span>
              </button>
              <button type="button" className="wb-subtab-close" aria-label={`Close ${terminal.title} ${index + 1}`} onClick={() => void close(terminal.id)}>
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
        <button type="button" className="icon-button small" aria-label="New terminal" title="New terminal" onClick={() => void create()}>
          <Plus size={14} />
        </button>
      </div>
      <div className="wb-card terminal-card">
        {error && <div className="notice notice-error wb-notice" role="alert"><span>{error}</span></div>}
        {terminals && terminals.length === 0 && !error && (
          <div className="wb-empty">
            <SquareTerminal size={18} />
            <p>No terminal is open. <button type="button" className="link-button inline" onClick={() => void create()}>Open one</button> in this workspace.</p>
          </div>
        )}
        {active && <XtermPane key={active} id={active} visible={visible} />}
      </div>
    </div>
  )
}

/** xterm reads concrete colours, so the palette comes from the live CSS tokens. */
function themeFromTokens(): ITheme {
  const style = getComputedStyle(document.documentElement)
  const token = (name: string) => style.getPropertyValue(name).trim()
  return {
    background: token('--code-bg'),
    foreground: token('--text'),
    cursor: token('--accent'),
    cursorAccent: token('--code-bg'),
    selectionBackground: token('--selection'),
    black: token('--border-strong'),
    red: token('--danger'),
    green: token('--success'),
    yellow: token('--warn'),
    blue: token('--accent'),
    magenta: token('--syntax-keyword'),
    cyan: token('--syntax-property'),
    white: token('--text-2'),
    brightBlack: token('--text-3'),
    brightRed: token('--danger'),
    brightGreen: token('--success'),
    brightYellow: token('--warn'),
    brightBlue: token('--accent-text'),
    brightMagenta: token('--syntax-keyword'),
    brightCyan: token('--syntax-property'),
    brightWhite: token('--text'),
  }
}

const MOD = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl+'

function copySelection(term: Terminal): void {
  const text = term.getSelection()
  if (!text) return
  void navigator.clipboard.writeText(text).catch(() => undefined)
  term.clearSelection()
}

function XtermPane({ id, visible }: { id: string; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const fitRef = useRef<FitAddon | undefined>(undefined)
  const termRef = useRef<Terminal | undefined>(undefined)
  const [menu, setMenu] = useState<{ x: number; y: number; selection: boolean }>()

  useEffect(() => {
    const element = host.current
    if (!element) return
    const style = getComputedStyle(document.documentElement)
    const term = new Terminal({
      fontFamily: style.getPropertyValue('--font-mono').trim() || 'monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
      theme: themeFromTokens(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(element)
    // Returning false hands the key back to the browser: a paste key then fires
    // the native paste event, which xterm turns into input.
    term.attachCustomKeyEventHandler(event => {
      const action = terminalClipboardKey(event, term.hasSelection())
      if (action === 'copy') {
        event.preventDefault()
        copySelection(term)
      }
      return action === undefined
    })
    termRef.current = term
    fitRef.current = fit

    // Keystrokes are batched per frame so a paste is one request, not one per character.
    let pending = ''
    let scheduled = 0
    const typed = term.onData(data => {
      pending += data
      if (scheduled) return
      scheduled = requestAnimationFrame(() => {
        scheduled = 0
        const chunk = pending
        pending = ''
        void workbenchApi.input(id, chunk).catch(() => undefined)
      })
    })
    const resized = term.onResize(({ cols, rows }) => { void workbenchApi.resize(id, cols, rows).catch(() => undefined) })

    const controller = new AbortController()
    void workbenchApi.stream(id, event => {
      if (event.type === 'data') term.write(event.data)
      else term.write(`\r\n\u001b[2m[process exited with code ${event.code}]\u001b[0m\r\n`)
    }, controller.signal).catch(() => undefined)

    const refit = () => { if (element.clientWidth > 0 && element.clientHeight > 0) fit.fit() }
    const observer = new ResizeObserver(() => requestAnimationFrame(refit))
    observer.observe(element)
    // Follow light/dark switches.
    const themeWatch = new MutationObserver(() => { term.options.theme = themeFromTokens() })
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] })
    requestAnimationFrame(refit)

    return () => {
      controller.abort()
      observer.disconnect()
      themeWatch.disconnect()
      cancelAnimationFrame(scheduled)
      typed.dispose()
      resized.dispose()
      term.dispose()
      termRef.current = undefined
    }
  }, [id])

  useEffect(() => {
    if (!visible) return
    requestAnimationFrame(() => {
      fitRef.current?.fit()
      termRef.current?.focus()
    })
  }, [visible])

  const paste = async () => {
    const term = termRef.current
    const text = await navigator.clipboard.readText().catch(() => '')
    if (term && text) term.paste(text)
    term?.focus()
  }
  const act = (action: () => void) => () => {
    setMenu(undefined)
    action()
    termRef.current?.focus()
  }

  return (
    <>
      <div
        className="xterm-host"
        ref={host}
        onContextMenu={event => {
          event.preventDefault()
          setMenu({ x: event.clientX, y: event.clientY, selection: termRef.current?.hasSelection() ?? false })
        }}
      />
      {menu && (
        <TerminalMenu x={menu.x} y={menu.y} onClose={() => setMenu(undefined)}>
          <TerminalMenuItem icon={<Copy size={14} />} label="Copy" hint={`${MOD}C`} disabled={!menu.selection} onSelect={act(() => { if (termRef.current) copySelection(termRef.current) })} />
          <TerminalMenuItem icon={<ClipboardPaste size={14} />} label="Paste" hint={`${MOD}V`} onSelect={() => { setMenu(undefined); void paste() }} />
          <div className="menu-separator" role="separator" />
          <TerminalMenuItem icon={<SquareDashedText size={14} />} label="Select all" onSelect={act(() => termRef.current?.selectAll())} />
          <TerminalMenuItem icon={<Eraser size={14} />} label="Clear" onSelect={act(() => termRef.current?.clear())} />
        </TerminalMenu>
      )}
    </>
  )
}

/** A right-click menu at the pointer, kept inside the window; on body so no ancestor shifts it. */
function TerminalMenu({ x, y, onClose, children }: { x: number; y: number; onClose: () => void; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })
  useDismiss(true, root, onClose)
  useEffect(() => {
    // Layout size, not the bounding box: the pop-in animation scales the menu.
    const box = root.current
    if (!box) return
    setPosition({ left: Math.max(4, Math.min(x, window.innerWidth - box.offsetWidth - 4)), top: Math.max(4, Math.min(y, window.innerHeight - box.offsetHeight - 4)) })
  }, [x, y])
  return createPortal(
    <div ref={root} className="menu-popover terminal-menu" role="menu" aria-label="Terminal" style={position}>
      {children}
    </div>,
    document.body,
  )
}

function TerminalMenuItem({ icon, label, hint, disabled, onSelect }: { icon: ReactNode; label: string; hint?: string; disabled?: boolean; onSelect: () => void }) {
  return (
    <button type="button" role="menuitem" className="menu-item" disabled={disabled} onClick={onSelect}>
      <span className="menu-item-icon">{icon}</span>
      <span className="menu-item-label">{label}</span>
      {hint && <span className="menu-item-hint">{hint}</span>}
    </button>
  )
}
