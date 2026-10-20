import { ImageIcon, Pencil, X } from 'lucide-react'
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
  return (
    <section className="queued-panel" aria-label="Queued messages">
      <div className="queued-head">
        {live ? 'Queued · sent when this run ends' : 'Queued · waiting for you'}
      </div>
      <ul className="queued-items">
        {items.map(item => (
          <li key={item.id} className="queued-item">
            <span className="queued-text" title={item.text}>{item.text || 'Images'}</span>
            {item.images.length > 0 && (
              <span className="queued-images" aria-label={`${item.images.length} image${item.images.length === 1 ? '' : 's'}`}>
                <ImageIcon size={12} />{item.images.length}
              </span>
            )}
            <button
              type="button"
              className="button ghost small"
              onClick={() => onSend(item)}
              title={live ? 'The agent reads it at its next step' : 'Send it as the next message'}
            >
              {live ? 'Steer now' : 'Send'}
            </button>
            <button type="button" className="icon-button tiny" aria-label="Edit queued message" title="Edit" onClick={() => onEdit(item)}>
              <Pencil size={12} />
            </button>
            <button type="button" className="icon-button tiny" aria-label="Remove queued message" title="Remove" onClick={() => onRemove(item)}>
              <X size={12} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
