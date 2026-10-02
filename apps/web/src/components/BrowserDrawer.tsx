import { ArrowLeft, ArrowRight, Globe, RotateCw, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { browserCommand, keyInput, navigateBrowser, pointAt, sendBrowserInput, streamBrowserLive, type LiveInput } from '../lib/browser-live'
import { desktopBrowser, displayUrl, OVERLAY_SELECTOR, viewportRect, type DesktopBrowserBridge } from '../lib/desktop-browser'

interface PageState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

const EMPTY: PageState = { url: 'about:blank', title: '', loading: false, canGoBack: false, canGoForward: false }

/**
 * The agent's browser, inside the app. In the desktop app the page is a
 * native view laid over `.browser-viewport`; in a web page it is a live
 * screencast of the server's headless browser that you can click, scroll
 * and type into. Either way you browse the same page the agent drives.
 */
export function BrowserDrawer({ onClose }: { onClose: () => void }) {
  const bridge = desktopBrowser()
  const [state, setState] = useState(EMPTY)
  return (
    <aside className="drawer browser-drawer" aria-label="Browser">
      <AddressBar
        state={state}
        onClose={onClose}
        onNavigate={url => bridge ? bridge.navigate(url) : void navigateBrowser(url).catch(() => {})}
        onCommand={command => bridge ? bridge.command(command) : void browserCommand(command).catch(() => {})}
      />
      {bridge ? <NativeViewport bridge={bridge} onState={setState} /> : <LiveViewport onState={setState} />}
    </aside>
  )
}

function AddressBar({ state, onNavigate, onCommand, onClose }: {
  state: PageState
  onNavigate: (url: string) => void
  onCommand: (command: 'back' | 'forward' | 'reload') => void
  onClose: () => void
}) {
  const [address, setAddress] = useState('')
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!editing) setAddress(displayUrl(state.url))
  }, [state.url, editing])
  const submit = () => {
    const value = address.trim()
    if (value) onNavigate(value)
    setEditing(false)
  }
  return (
    <header className="drawer-header browser-bar">
      <button type="button" className="icon-button" aria-label="Back" title="Back" disabled={!state.canGoBack} onClick={() => onCommand('back')}>
        <ArrowLeft size={16} />
      </button>
      <button type="button" className="icon-button" aria-label="Forward" title="Forward" disabled={!state.canGoForward} onClick={() => onCommand('forward')}>
        <ArrowRight size={16} />
      </button>
      <button type="button" className="icon-button" aria-label="Reload" title="Reload" onClick={() => onCommand('reload')}>
        <RotateCw size={15} />
      </button>
      <form className="browser-address" onSubmit={event => { event.preventDefault(); submit() }}>
        <Globe size={13} aria-hidden />
        <input
          value={address}
          placeholder="localhost:5173"
          aria-label="Address"
          spellCheck={false}
          onFocus={event => { setEditing(true); event.currentTarget.select() }}
          onBlur={() => { setEditing(false); setAddress(displayUrl(state.url)) }}
          onChange={event => setAddress(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Escape') {
              setAddress(displayUrl(state.url))
              event.currentTarget.blur()
            }
          }}
        />
      </form>
      <button type="button" className="icon-button" aria-label="Close browser" title="Close browser" onClick={onClose}>
        <X size={16} />
      </button>
    </header>
  )
}

function EmptyPage({ children }: { children?: ReactNode }) {
  return (
    <div className="browser-empty">
      <Globe size={22} />
      <p>{children ?? 'The agent opens pages here when it checks your frontend. You can browse too.'}</p>
    </div>
  )
}

/** Desktop: tell the main process where to put the native view. */
function NativeViewport({ bridge, onState }: { bridge: DesktopBrowserBridge; onState: (state: PageState) => void }) {
  const viewport = useRef<HTMLDivElement>(null)
  const [url, setUrl] = useState('about:blank')

  useEffect(() => {
    const off = bridge.onState(next => {
      onState(next)
      setUrl(next.url)
    })
    bridge.command('state')
    return off
  }, [bridge, onState])

  // Keep the native view glued to the placeholder, and out of the way of overlays.
  useLayoutEffect(() => {
    let frame = 0
    const place = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        bridge.setBounds(viewportRect(viewport.current, Boolean(document.querySelector(OVERLAY_SELECTOR))))
      })
    }
    place()
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place)
    if (viewport.current) resize?.observe(viewport.current)
    const overlays = new MutationObserver(place)
    overlays.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('resize', place)
    return () => {
      cancelAnimationFrame(frame)
      resize?.disconnect()
      overlays.disconnect()
      window.removeEventListener('resize', place)
      bridge.setBounds(null)
    }
  }, [bridge])

  return (
    <div className="browser-viewport" ref={viewport}>
      {displayUrl(url) === '' && <EmptyPage />}
    </div>
  )
}

/** Web: show the server's screencast and send the user's input back. */
function LiveViewport({ onState }: { onState: (state: PageState) => void }) {
  const image = useRef<HTMLImageElement>(null)
  const [frame, setFrame] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const lastMove = useRef(0)
  const history = useRef<{ urls: string[]; index: number }>({ urls: [], index: -1 })

  useEffect(() => {
    const controller = new AbortController()
    let retry: ReturnType<typeof setTimeout> | undefined
    const connect = () => {
      streamBrowserLive(event => {
        setError(undefined)
        if (event.type === 'frame') {
          setFrame(`data:image/jpeg;base64,${event.data}`)
          return
        }
        // The headless page has no back/forward state of its own to report; approximate it.
        const trail = history.current
        if (trail.urls[trail.index] !== event.url && event.url !== 'about:blank') {
          trail.urls = [...trail.urls.slice(0, trail.index + 1), event.url]
          trail.index = trail.urls.length - 1
        }
        onState({ url: event.url, title: event.title, loading: false, canGoBack: trail.index > 0, canGoForward: trail.index < trail.urls.length - 1 })
      }, controller.signal).catch(reason => {
        if (controller.signal.aborted) return
        setError(reason instanceof Error ? reason.message : String(reason))
        retry = setTimeout(connect, 2_000)
      })
    }
    connect()
    return () => {
      controller.abort()
      if (retry) clearTimeout(retry)
    }
  }, [onState])

  const send = (input: LiveInput) => {
    void sendBrowserInput(input).catch(() => {})
  }
  const at = (event: { clientX: number; clientY: number }) => pointAt(event, image.current?.getBoundingClientRect() ?? { left: 0, top: 0, width: 0, height: 0 })

  return (
    <div
      className="browser-viewport browser-live"
      tabIndex={0}
      aria-label="Agent browser page"
      onKeyDown={event => {
        const input = keyInput(event)
        if (!input) return
        event.preventDefault()
        send(input)
      }}
      onPaste={event => {
        const text = event.clipboardData.getData('text')
        if (!text) return
        event.preventDefault()
        send({ kind: 'text', text })
      }}
    >
      {frame
        ? (
          <img
            ref={image}
            src={frame}
            alt="Agent browser page"
            draggable={false}
            onMouseDown={event => event.preventDefault()}
            onClick={event => {
              event.currentTarget.parentElement?.focus()
              send({ kind: 'click', ...at(event), clickCount: event.detail >= 2 ? 2 : 1 })
            }}
            onContextMenu={event => {
              event.preventDefault()
              send({ kind: 'click', ...at(event), button: 'right' })
            }}
            onMouseMove={event => {
              const now = Date.now()
              if (now - lastMove.current < 80) return
              lastMove.current = now
              send({ kind: 'move', ...at(event) })
            }}
            onWheel={event => send({ kind: 'wheel', ...at(event), deltaX: event.deltaX, deltaY: event.deltaY })}
          />
        )
        : <EmptyPage>{error ? `Connecting to the browser… (${error})` : undefined}</EmptyPage>}
    </div>
  )
}
