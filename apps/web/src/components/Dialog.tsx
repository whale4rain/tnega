import { X } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'

export function Dialog({
  title,
  description,
  onClose,
  children,
  footer,
  width = 520,
}: {
  title: string
  description?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
}) {
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const first = panel.current?.querySelector<HTMLElement>('input, textarea, select, button:not(.dialog-close)')
    first?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      previous?.focus?.()
    }
  }, [onClose])
  return (
    <div className="dialog-scrim" onPointerDown={event => event.target === event.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} ref={panel} style={{ maxWidth: width }}>
        <header className="dialog-header">
          <div>
            <h2 className="dialog-title">{title}</h2>
            {description && <p className="dialog-description">{description}</p>}
          </div>
          <button type="button" className="icon-button dialog-close" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="dialog-body">{children}</div>
        {footer && <footer className="dialog-footer">{footer}</footer>}
      </div>
    </div>
  )
}
