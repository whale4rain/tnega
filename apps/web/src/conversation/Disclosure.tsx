import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

/** Native disclosure keeps keyboard, focus and expanded semantics in the browser. */
export function Disclosure({
  title,
  icon,
  status,
  children,
  className = '',
  defaultOpen = false,
}: {
  title: ReactNode
  icon?: ReactNode
  status?: ReactNode
  children: ReactNode
  className?: string
  defaultOpen?: boolean
}) {
  return (
    <details className={`disclosure ${className}`} open={defaultOpen}>
      <summary className="disclosure-trigger">
        {icon}
        <span className="disclosure-title">{title}</span>
        {status && <span className="disclosure-status">{status}</span>}
        <ChevronRight
          size={13}
          className="disclosure-chevron"
          aria-hidden="true"
        />
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  )
}
