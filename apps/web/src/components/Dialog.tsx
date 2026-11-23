import { X } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export function Dialog({
  title,
  description,
  onClose,
  children,
  footer,
  actions,
  icon,
  className,
  width = 520,
  header = true,
}: {
  title: string
  description?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  /** Buttons that act on the whole dialog's content, beside Close. */
  actions?: ReactNode
  /** A glyph before the title, for dialogs that show one object. */
  icon?: ReactNode
  className?: string
  width?: number
  /** False for a dialog that lays out its own title (Settings puts it atop its nav); Close still floats top right. */
  header?: boolean
}) {
  const panel = useRef<HTMLDivElement>(null)
  // Keep Escape current without re-running the mount focus effect when callers pass an inline onClose.
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const first = panel.current?.querySelector<HTMLElement>('input, textarea, select, button:not(.dialog-close)')
    first?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      previous?.focus?.()
    }
  }, [])
  // Rendered last in <body>: above every header, and after the desktop title bar's drag regions so its
  // no-drag area wins and the buttons under the window controls' row stay clickable.
  return createPortal(
    <div className="dialog-scrim" onPointerDown={event => event.target === event.currentTarget && onClose()}>
      <div className={`dialog${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={panel} style={{ maxWidth: width }}>
        {header ? (
          <header className="dialog-header">
            {icon && <span className="dialog-icon" aria-hidden>{icon}</span>}
            <div>
              <h2 className="dialog-title">{title}</h2>
              {description && <p className="dialog-description">{description}</p>}
            </div>
            {actions && <div className="dialog-actions">{actions}</div>}
            <button type="button" className="icon-button dialog-close" aria-label="Close" onClick={onClose}>
              <X size={16} />
            </button>
          </header>
        ) : (
          <button type="button" className="icon-button dialog-close dialog-close-floating" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        )}
        <div className="dialog-body">{children}</div>
        {footer && <footer className="dialog-footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  )
}
