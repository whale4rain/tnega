import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { PPTXViewer } from 'pptxviewjs'
import { errorText } from '../../lib/hooks'
import type { PreviewProps } from './FilePreview'

/** pptxviewjs pins the canvas to its pixel size with inline styles; let CSS scale it to the dialog instead. */
function releaseSize(canvas: HTMLCanvasElement | null): void {
  canvas?.style.removeProperty('width')
  canvas?.style.removeProperty('height')
}

export default function PptxPreview({ blob }: PreviewProps) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const viewer = useRef<PPTXViewer | undefined>(undefined)
  const [count, setCount] = useState(0)
  const [index, setIndex] = useState(0)
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    let cancelled = false
    const target = canvas.current
    if (!target) return
    setCount(0)
    setIndex(0)
    setError(undefined)
    void (async () => {
      try {
        const { PPTXViewer } = await import('pptxviewjs')
        const instance = new PPTXViewer({ canvas: target, slideSizeMode: 'fit', backgroundColor: '#ffffff' })
        await instance.loadFile(await blob.arrayBuffer())
        if (cancelled) {
          instance.destroy()
          return
        }
        viewer.current = instance
        await instance.render(target, { slideIndex: 0 })
        releaseSize(target)
        if (!cancelled) setCount(instance.getSlideCount())
      } catch (reason) {
        if (!cancelled) setError(errorText(reason))
      }
    })()
    return () => {
      cancelled = true
      viewer.current?.destroy()
      viewer.current = undefined
    }
  }, [blob])

  const go = (next: number) => {
    const instance = viewer.current
    if (!instance || next < 0 || next >= count) return
    setIndex(next)
    instance.goToSlide(next, canvas.current)
      .then(() => releaseSize(canvas.current), reason => setError(errorText(reason)))
  }

  return (
    <div className="pptx-preview">
      {error && <div className="notice notice-error"><span>Could not render this presentation: {error}</span></div>}
      {!error && count === 0 && <div className="file-preview-status"><span className="spinner" /> Rendering slides…</div>}
      <canvas ref={canvas} width={1280} height={720} className="pptx-canvas" hidden={Boolean(error) || count === 0} />
      {count > 0 && (
        <div className="pptx-nav">
          <button type="button" className="icon-button" aria-label="Previous slide" disabled={index === 0} onClick={() => go(index - 1)}>
            <ChevronLeft size={14} />
          </button>
          <span className="muted small">Slide {index + 1} of {count}</span>
          <button type="button" className="icon-button" aria-label="Next slide" disabled={index >= count - 1} onClick={() => go(index + 1)}>
            <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  )
}
