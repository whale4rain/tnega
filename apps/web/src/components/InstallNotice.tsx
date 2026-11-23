import { X } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'
import { useCopy } from '../lib/hooks'

/**
 * A notice that something needs installing (Umbrella asks.md, Notices): one white card one line tall, a
 * sunken disc with the subject's icon, a sentence, one sunken pill action and a round close. "How to
 * install" opens the command inside the same card, in a sunken mono block with an ink "Copy command".
 */
export function InstallNotice({ icon, children, command, after, about, dismissLabel, onDismiss }: {
  icon: ReactNode
  /** The one sentence: what is missing and what it costs. */
  children: ReactNode
  command: string
  /** What to do once the command has run, shown under it. */
  after: string
  about: { url: string; label: string }
  dismissLabel: string
  onDismiss: () => void
}) {
  const [open, setOpen] = useState(false)
  const [copied, copy] = useCopy()
  const details = useId()
  return (
    <div className={`notice-card install-notice${open ? ' open' : ''}`} role="status">
      <div className="notice-line">
        <span className="notice-disc" aria-hidden>{icon}</span>
        <span className="notice-text">{children}</span>
        <button type="button" className="notice-action" aria-expanded={open} aria-controls={details} onClick={() => setOpen(value => !value)}>
          How to install
        </button>
        <button type="button" className="notice-close" aria-label={dismissLabel} title={dismissLabel} onClick={onDismiss}>
          <X size={16} aria-hidden />
        </button>
      </div>
      {open && (
        <div className="notice-details" id={details}>
          <pre className="notice-command"><code>{command}</code></pre>
          <div className="notice-details-foot">
            <span className="notice-after">
              {after}{' '}
              <a href={about.url} target="_blank" rel="noreferrer noopener">{about.label}</a>
            </span>
            <button type="button" className="button primary small" onClick={() => copy(command)}>
              {copied ? 'Copied' : 'Copy command'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
