import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { Plus, SquareTerminal, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { errorText } from '../../lib/hooks'
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
                <SquareTerminal size={13} aria-hidden />
                <span>{terminal.title} {index + 1}</span>
              </button>
              <button type="button" className="wb-subtab-close" aria-label={`Close ${terminal.title} ${index + 1}`} onClick={() => void close(terminal.id)}>
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
        <button type="button" className="icon-button small" aria-label="New terminal" title="New terminal" onClick={() => void create()}>
          <Plus size={15} />
        </button>
      </div>
      <div className="wb-card terminal-card">
        {error && <div className="notice notice-error wb-notice" role="alert"><span>{error}</span></div>}
        {terminals && terminals.length === 0 && !error && (
          <div className="wb-empty">
            <SquareTerminal size={22} />
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

function XtermPane({ id, visible }: { id: string; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const fitRef = useRef<FitAddon | undefined>(undefined)
  const termRef = useRef<Terminal | undefined>(undefined)

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

  return <div className="xterm-host" ref={host} />
}
