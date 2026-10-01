import { ArrowLeft, ArrowRight, Globe, RotateCw, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { desktopBrowser, displayUrl, OVERLAY_SELECTOR, viewportRect, type DesktopBrowserState } from '../lib/desktop-browser'

const EMPTY: DesktopBrowserState = { url: 'about:blank', title: '', loading: false, canGoBack: false, canGoForward: false }

/**
 * The agent's browser in the desktop app. The page itself is a native view the
 * main process lays over `.browser-viewport`; this component only tells it
 * where to sit and offers the usual navigation controls, so the developer can
 * browse alongside the agent.
 */
export function BrowserDrawer({ onClose }: { onClose: () => void }) {
  const bridge = desktopBrowser()
  const viewport = useRef<HTMLDivElement>(null)
  const [state, setState] = useState(EMPTY)
  const [address, setAddress] = useState('')
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    if (!bridge) return
    const off = bridge.onState(next => {
      setState(next)
      if (!editing) setAddress(displayUrl(next.url))
    })
    bridge.command('state')
    return off
  }, [bridge, editing])

  // Keep the native view glued to the placeholder, and out of the way of overlays.
  useLayoutEffect(() => {
    if (!bridge) return
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

  if (!bridge) return null
  const submit = () => {
    const value = address.trim()
    if (value) bridge.navigate(value)
    setEditing(false)
  }

  return (
    <aside className="drawer browser-drawer" aria-label="Browser">
      <header className="drawer-header browser-bar">
        <button type="button" className="icon-button" aria-label="Back" title="Back" disabled={!state.canGoBack} onClick={() => bridge.command('back')}>
          <ArrowLeft size={16} />
        </button>
        <button type="button" className="icon-button" aria-label="Forward" title="Forward" disabled={!state.canGoForward} onClick={() => bridge.command('forward')}>
          <ArrowRight size={16} />
        </button>
        <button
          type="button"
          className={`icon-button${state.loading ? ' is-loading' : ''}`}
          aria-label={state.loading ? 'Stop' : 'Reload'}
          title={state.loading ? 'Stop' : 'Reload'}
          onClick={() => bridge.command(state.loading ? 'stop' : 'reload')}
        >
          {state.loading ? <X size={16} /> : <RotateCw size={15} />}
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
      <div className="browser-viewport" ref={viewport}>
        {displayUrl(state.url) === '' && (
          <div className="browser-empty">
            <Globe size={22} />
            <p>The agent opens pages here when it checks your frontend. You can browse too.</p>
          </div>
        )}
      </div>
    </aside>
  )
}
