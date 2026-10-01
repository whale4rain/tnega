import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { errorText } from '../../lib/hooks'
import type { ChartView } from '../../lib/ooxml-chart'
import { ChartCanvas } from './ChartCanvas'
import type { PreviewProps } from './FilePreview'

interface Charts {
  views: ChartView[]
  /** Where each chart goes inside the rendered pages; empty when they can't be matched up. */
  slots: HTMLElement[]
}

/**
 * docx-preview reserves an empty, sized box for every drawing it cannot render, charts
 * included. Those boxes are the chart slots, in document order.
 */
function emptyDrawingSlots(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('section.docx div'))
    .filter(element => element.style.display === 'inline-block' && element.style.height !== '' && element.childElementCount === 0)
}

export default function DocxPreview({ blob }: PreviewProps) {
  const body = useRef<HTMLDivElement>(null)
  const styles = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'loading' | 'ready' | { error: string }>('loading')
  const [charts, setCharts] = useState<Charts>({ views: [], slots: [] })

  useEffect(() => {
    let cancelled = false
    const container = body.current
    const styleContainer = styles.current
    if (!container || !styleContainer) return
    setState('loading')
    setCharts({ views: [], slots: [] })
    void (async () => {
      try {
        const [{ renderAsync }, { default: JSZip }, { documentCharts }] = await Promise.all([
          import('docx-preview'), import('jszip'), import('../../lib/ooxml-chart'),
        ])
        await renderAsync(blob, container, styleContainer, {
          className: 'docx',
          inWrapper: true,
          ignoreLastRenderedPageBreak: true,
        })
        const views = await documentCharts(await JSZip.loadAsync(await blob.arrayBuffer()))
        if (cancelled) return
        const slots = emptyDrawingSlots(container)
        setCharts({ views, slots: slots.length === views.length ? slots : [] })
        setState('ready')
      } catch (reason) {
        if (!cancelled) setState({ error: errorText(reason) })
      }
    })()
    return () => {
      cancelled = true
      container.replaceChildren()
      styleContainer.replaceChildren()
    }
  }, [blob])

  const placed = charts.slots.length > 0
  return (
    <div className="docx-preview">
      {state === 'loading' && <div className="file-preview-status"><span className="spinner" /> Rendering document…</div>}
      {typeof state === 'object' && <div className="notice notice-error"><span>Could not render this document: {state.error}</span></div>}
      <div ref={styles} />
      <div ref={body} />
      {placed && charts.views.map((chart, index) => {
        const slot = charts.slots[index]
        return slot ? createPortal(<ChartCanvas chart={chart} fill />, slot, `chart-${index}`) : null
      })}
      {!placed && charts.views.length > 0 && (
        <div className="chart-list">
          <p className="muted small">Charts in this document</p>
          {charts.views.map((chart, index) => <ChartCanvas key={index} chart={chart} />)}
        </div>
      )}
    </div>
  )
}
