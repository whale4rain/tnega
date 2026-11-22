import { ArrowUp, ImageIcon, Pencil, X } from 'lucide-react'
import { PenMark } from './PenMark'
import type { ImageAttachment } from '../lib/types'

/** A message typed while the agent runs, held until the run ends or steered in now. */
export interface QueuedMessage {
  id: string
  text: string
  images: ImageAttachment[]
}

/**
 * Messages waiting above the composer. While the agent runs each can be
 * steered into the run now; otherwise sent as the next prompt. Edit puts one
 * back into the composer.
 */
export function QueuedMessages({
  items,
  live,
  onSend,
  onEdit,
  onRemove,
}: {
  items: readonly QueuedMessage[]
  live: boolean
  onSend: (item: QueuedMessage) => void
  onEdit: (item: QueuedMessage) => void
  onRemove: (item: QueuedMessage) => void
}) {
  if (!items.length) return null
  const when = live ? 'Sent when this run ends' : 'Waiting for you to send it'
  return (
    <section className="queued-panel" aria-label="Queued messages">
      <ul className="queued-items">
        {items.map(item => (
          <li key={item.id} className="queued-item">
            <PenMark kind="waiting" size={16} label={when} />
            <span className="queued-text" title={item.text}>{item.text || 'Images'}</span>
            {item.images.length > 0 && (
              <span className="queued-images" aria-label={`${item.images.length} image${item.images.length === 1 ? '' : 's'}`}>
                <ImageIcon size={12} />{item.images.length}
              </span>
            )}
            <button type="button" className="queued-action" aria-label="Edit queued message" title="Edit" onClick={() => onEdit(item)}>
              <Pencil size={14} />
            </button>
            <button type="button" className="queued-action" aria-label="Remove queued message" title="Remove" onClick={() => onRemove(item)}>
              <X size={14} />
            </button>
            <button
              type="button"
              className="queued-action queued-send"
              aria-label={live ? 'Steer now' : 'Send now'}
              onClick={() => onSend(item)}
              title={live ? 'Steer now: the agent reads it at its next step' : 'Send it as the next message'}
            >
              <ArrowUp size={14} strokeWidth={2.2} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
