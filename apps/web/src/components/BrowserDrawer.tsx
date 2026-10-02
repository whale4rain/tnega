import { ArrowLeft, ArrowRight, Globe, Plus, RotateCw, SquareMousePointer, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  browserCommand,
  browserTab,
  cancelPick,
  describePicked,
  insertIntoComposer,
  keyInput,
  navigateBrowser,
  pickElement,
  pickedLabel,
  pointAt,
  sendBrowserInput,
  setBrowserViewport,
  streamBrowserLive,
  type LiveInput,
  type LiveTab,
} from '../lib/browser-live'
import { desktopBrowser, displayUrl, OVERLAY_SELECTOR, viewportRect, type DesktopBrowserBridge } from '../lib/desktop-browser'

interface PageState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
}

const EMPTY: PageState = { url: 'about:blank', title: '', canGoBack: false, canGoForward: false }

/** Narrowest and widest the panel may be dragged, in CSS pixels. */
export const BROWSER_MIN_WIDTH = 360
export const BROWSER_MAX_SHARE = 0.72

/**
 * The agent's browser, inside the app, laid out like a browser: tabs, a
 * toolbar with the address and the element picker, and the page in a rounded
 * card that fills the rest of the panel. In the desktop app the page is a
 * native view laid over the card; in a web page it is a live screencast of
 * the server's headless browser rendered at the card's size. Either way you
 * browse the same tabs the agent drives.
 */
export function BrowserDrawer({ onClose, onResize, width }: { onClose: () => void; onResize?: (width: number) => void; width?: number | undefined }) {
  const bridge = desktopBrowser()
  const [state, setState] = useState(EMPTY)
  const [tabs, setTabs] = useState<LiveTab[]>([])
  const [frame, setFrame] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [picking, setPicking] = useState(false)
  const history = useRef<{ urls: string[]; index: number }>({ urls: [], index: -1 })

  // Tabs and page state come from the server in both hosts; frames only in the web app.
  useEffect(() => {
    const controller = new AbortController()
    let retry: ReturnType<typeof setTimeout> | undefined
    const connect = () => {
      streamBrowserLive(event => {
        setError(undefined)
        if (event.type === 'frame') {
          setFrame(`data:image/jpeg;base64,${event.data}`)
        } else if (event.type === 'tabs') {
          setTabs(event.tabs)
        } else if (!bridge) {
          // The headless page reports no history of its own; approximate it for the buttons.
          const trail = history.current
          if (trail.urls[trail.index] !== event.url && event.url !== 'about:blank') {
            trail.urls = [...trail.urls.slice(0, trail.index + 1), event.url]
            trail.index = trail.urls.length - 1
          }
          setState({ url: event.url, title: event.title, canGoBack: trail.index > 0, canGoForward: trail.index < trail.urls.length - 1 })
        }
      }, controller.signal, { frames: !bridge }).catch(reason => {
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
  }, [bridge])

  useEffect(() => bridge?.onState(next => setState(next)), [bridge])

  const navigate = (url: string) => bridge ? bridge.navigate(url) : void navigateBrowser(url).catch(() => {})
  const command = (name: 'back' | 'forward' | 'reload') => bridge ? bridge.command(name) : void browserCommand(name).catch(() => {})

  const togglePick = async () => {
    if (picking) {
      void cancelPick().catch(() => {})
      return
    }
    setPicking(true)
    try {
      const picked = await pickElement()
      if (picked) {
        insertIntoComposer({
          context: { label: pickedLabel(picked.element), text: describePicked(picked.element) },
          ...(picked.image ? { images: [{ type: 'image', ...picked.image, name: `${picked.element.tag}.jpg` }] } : {}),
        })
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setPicking(false)
    }
  }

  return (
    <aside className="drawer browser-drawer" aria-label="Browser">
      {onResize && <ResizeHandle onResize={onResize} />}
      <TabStrip
        tabs={tabs}
        onSelect={id => void browserTab('select', id).catch(() => {})}
        onClose={id => void browserTab('close', id).catch(() => {})}
        onNew={() => void browserTab('new').catch(() => {})}
        onClosePanel={onClose}
      />
      <Toolbar state={state} picking={picking} onNavigate={navigate} onCommand={command} onPick={() => void togglePick()} />
      <div className="browser-card">
        {bridge
          ? <NativeViewport bridge={bridge} url={state.url} />
          : <LiveViewport frame={frame} error={error} width={width} />}
        {picking && <div className="browser-pick-hint">Click an element to add it to your message · Esc to cancel</div>}
      </div>
    </aside>
  )
}

function ResizeHandle({ onResize }: { onResize: (width: number) => void }) {
  const [dragging, setDragging] = useState(false)
  return (
    <div
      className={`browser-resize${dragging ? ' is-dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize browser"
      onPointerDown={event => {
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        setDragging(true)
      }}
      onPointerMove={event => {
        if (!dragging) return
        const max = window.innerWidth * BROWSER_MAX_SHARE
        onResize(Math.round(Math.min(max, Math.max(BROWSER_MIN_WIDTH, window.innerWidth - event.clientX))))
      }}
      onPointerUp={event => {
        event.currentTarget.releasePointerCapture(event.pointerId)
        setDragging(false)
      }}
    />
  )
}

function TabStrip({ tabs, onSelect, onClose, onNew, onClosePanel }: {
  tabs: LiveTab[]
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
  onClosePanel: () => void
}) {
  return (
    <div className="browser-tabs" role="tablist" aria-label="Browser tabs">
      {tabs.map(tab => (
        <div key={tab.id} className={`browser-tab${tab.active ? ' active' : ''}`} role="tab" aria-selected={tab.active} title={tab.url}>
          <button type="button" className="browser-tab-main" onClick={() => onSelect(tab.id)}>
            <Globe size={13} aria-hidden />
            <span className="browser-tab-title">{tab.title || displayUrl(tab.url) || 'New tab'}</span>
          </button>
          <button type="button" className="browser-tab-close" aria-label={`Close ${tab.title || 'tab'}`} onClick={() => onClose(tab.id)}>
            <X size={12} />
          </button>
        </div>
      ))}
      <button type="button" className="icon-button small" aria-label="New tab" title="New tab" onClick={onNew}>
        <Plus size={15} />
      </button>
      <span className="browser-tabs-fill" />
      <button type="button" className="icon-button small" aria-label="Close browser" title="Close browser" onClick={onClosePanel}>
        <X size={15} />
      </button>
    </div>
  )
}

function Toolbar({ state, picking, onNavigate, onCommand, onPick }: {
  state: PageState
  picking: boolean
  onNavigate: (url: string) => void
  onCommand: (command: 'back' | 'forward' | 'reload') => void
  onPick: () => void
}) {
  const [address, setAddress] = useState('')
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!editing) setAddress(displayUrl(state.url))
  }, [state.url, editing])
  return (
    <div className="browser-toolbar">
      <button type="button" className="icon-button small" aria-label="Back" title="Back" disabled={!state.canGoBack} onClick={() => onCommand('back')}>
        <ArrowLeft size={16} />
      </button>
      <button type="button" className="icon-button small" aria-label="Forward" title="Forward" disabled={!state.canGoForward} onClick={() => onCommand('forward')}>
        <ArrowRight size={16} />
      </button>
      <button type="button" className="icon-button small" aria-label="Reload" title="Reload" onClick={() => onCommand('reload')}>
        <RotateCw size={15} />
      </button>
      <form
        className="browser-address"
        onSubmit={event => {
          event.preventDefault()
          if (address.trim()) onNavigate(address.trim())
          setEditing(false)
          event.currentTarget.querySelector('input')?.blur()
        }}
      >
        <input
          value={address}
          placeholder="Search or enter an address"
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
      <button
        type="button"
        className={`icon-button small${picking ? ' active' : ''}`}
        aria-label={picking ? 'Cancel picking' : 'Pick an element to chat about'}
        aria-pressed={picking}
        title="Pick an element to chat about"
        onClick={onPick}
      >
        <SquareMousePointer size={16} />
      </button>
    </div>
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
function NativeViewport({ bridge, url }: { bridge: DesktopBrowserBridge; url: string }) {
  const viewport = useRef<HTMLDivElement>(null)

  useEffect(() => { bridge.command('state') }, [bridge])

  // Keep the native view glued to the card, and out of the way of overlays.
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

/** Web: render the page at the card's size and send the user's input back. */
function LiveViewport({ frame, error, width }: { frame: string | undefined; error: string | undefined; width?: number | undefined }) {
  const viewport = useRef<HTMLDivElement>(null)
  const image = useRef<HTMLImageElement>(null)
  const lastMove = useRef(0)

  const fit = useCallback(() => {
    const element = viewport.current
    if (!element || element.clientWidth < 10 || element.clientHeight < 10) return
    void setBrowserViewport(element.clientWidth, element.clientHeight).catch(() => {})
  }, [])

  // The page renders at exactly the card's size, so the picture fills it without scaling.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const later = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(fit, 150)
    }
    later()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(later)
    if (viewport.current) observer?.observe(viewport.current)
    window.addEventListener('resize', later)
    return () => {
      if (timer) clearTimeout(timer)
      observer?.disconnect()
      window.removeEventListener('resize', later)
    }
  }, [fit, width])

  const send = (input: LiveInput) => {
    void sendBrowserInput(input).catch(() => {})
  }
  const at = (event: { clientX: number; clientY: number }) => pointAt(event, image.current?.getBoundingClientRect() ?? { left: 0, top: 0, width: 0, height: 0 })

  return (
    <div
      ref={viewport}
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
              if (now - lastMove.current < 60) return
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
