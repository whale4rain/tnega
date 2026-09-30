import { useEffect, useRef, useState } from 'react'
import { errorText } from '../../lib/hooks'
import type { PreviewProps } from './FilePreview'

export default function DocxPreview({ blob }: PreviewProps) {
  const body = useRef<HTMLDivElement>(null)
  const styles = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'loading' | 'ready' | { error: string }>('loading')

  useEffect(() => {
    let cancelled = false
    const container = body.current
    const styleContainer = styles.current
    if (!container || !styleContainer) return
    setState('loading')
    void (async () => {
      try {
        const { renderAsync } = await import('docx-preview')
        await renderAsync(blob, container, styleContainer, {
          className: 'docx',
          inWrapper: true,
          ignoreLastRenderedPageBreak: true,
        })
        if (!cancelled) setState('ready')
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

  return (
    <div className="docx-preview">
      {state === 'loading' && <div className="file-preview-status"><span className="spinner" /> Rendering document…</div>}
      {typeof state === 'object' && <div className="notice notice-error"><span>Could not render this document: {state.error}</span></div>}
      <div ref={styles} />
      <div ref={body} />
    </div>
  )
}
