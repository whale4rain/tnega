import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { imageSrc } from '../lib/attachments'
import type { ImageAttachment } from '../lib/types'

/** A row of image thumbnails; clicking one opens it full size. */
export function ImageStrip({ images, className }: { images: readonly ImageAttachment[]; className?: string }) {
  const [open, setOpen] = useState<number | undefined>()
  if (!images.length) return null
  const current = open === undefined ? undefined : images[open]
  return (
    <>
      <div className={`image-strip${className ? ` ${className}` : ''}`}>
        {images.map((image, index) => (
          <button
            key={`${index}-${image.data.length}`}
            type="button"
            className="image-thumb"
            onClick={() => setOpen(index)}
            aria-label={`Open ${image.name ?? `image ${index + 1}`}`}
          >
            <img src={imageSrc(image)} alt={image.name ?? `Image ${index + 1}`} loading="lazy" />
          </button>
        ))}
      </div>
      {current && <ImageViewer src={imageSrc(current)} name={current.name ?? 'Image'} onClose={() => setOpen(undefined)} />}
    </>
  )
}

/** One image at full size over the page; Escape or a click outside closes it. */
export function ImageViewer({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="image-viewer" role="dialog" aria-modal="true" aria-label={name} onPointerDown={event => event.target === event.currentTarget && onClose()}>
      <img src={src} alt={name} />
      <button type="button" className="icon-button image-viewer-close" aria-label="Close" onClick={onClose}>
        <X size={14} />
      </button>
    </div>
  )
}
