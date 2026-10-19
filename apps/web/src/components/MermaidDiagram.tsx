import { Check, Copy } from 'lucide-react'
import { useCallback, useContext, useEffect, useId, useRef, useState, type MouseEvent } from 'react'
import type { Mounted, MountOptions } from 'pele/lazy'
import { useCopy } from '../lib/hooks'
import { codePathTarget, LinkContext, linkTarget } from '../lib/links'
import { CodeBlock } from './CodeBlock'

/** `pele` is 740 kB of parsers and renderers: load it when the first diagram appears. */
let pele: Promise<typeof import('pele/lazy')> | undefined
function loadPele(): Promise<typeof import('pele/lazy')> {
  pele ??= import('pele/lazy').catch((error: unknown) => {
    pele = undefined
    throw error
  })
  return pele
}

/** Streaming rewrites the fence on every token; redraw once it settles. */
const SETTLE_MS = 150

/**
 * A fenced ```mermaid block drawn as a diagram. Pele reads the palette from the
 * `--pele-*` variables set on `.mermaid-canvas` (styles/app.css), so the
 * diagram follows `data-theme` / `data-palette` without a redraw. It escapes
 * diagram text and filters links, so nothing here trusts the model's markup.
 *
 * Anything pele cannot draw falls back to the code block the fence rendered as
 * before, so a diagram is never a dead end.
 */
export function MermaidDiagram({ code }: { code: string }) {
  const { workspace, openPath, openLocalUrl } = useContext(LinkContext)
  const [copied, copy] = useCopy()
  const [showSource, setShowSource] = useState(false)
  const [failed, setFailed] = useState(false)
  const container = useRef<HTMLDivElement>(null)
  const mounted = useRef<Mounted | undefined>(undefined)
  const idPrefix = `mermaid-${useId().replace(/\W/gu, '')}`

  const fail = useCallback(() => {
    mounted.current?.destroy()
    mounted.current = undefined
    setFailed(true)
  }, [])

  useEffect(() => {
    let cancelled = false
    setFailed(false)
    const timer = setTimeout(() => {
      const element = container.current
      if (!element) return
      const options: MountOptions = { idPrefix, zoom: 'auto', onError: fail }
      void (async () => {
        try {
          const module = await loadPele()
          if (cancelled) return
          if (mounted.current) mounted.current.update(code, options)
          else mounted.current = await module.mountAsync(element, code, options)
        } catch {
          if (!cancelled) fail()
        }
      })()
    }, SETTLE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [code, idPrefix, fail])

  useEffect(() => () => {
    mounted.current?.destroy()
    mounted.current = undefined
  }, [])

  /** The source toggle hides the container; a hidden diagram redraws when shown again. */
  useEffect(() => {
    if (!showSource) mounted.current?.refresh()
  }, [showSource])

  /**
   * Diagram links lead to the same places reply links do. Without this, an
   * anchor inside the SVG would navigate the app away from the conversation.
   */
  function openLink(event: MouseEvent<HTMLDivElement>) {
    const anchor = (event.target as Element).closest?.('a[href]')
    if (!anchor) return
    event.preventDefault()
    const href = anchor.getAttribute('href') ?? ''
    const target = linkTarget(href, workspace)
    if (target.kind === 'local') openLocalUrl?.(target.url)
    else if (target.kind === 'web') window.open(target.url, '_blank', 'noopener,noreferrer')
    else if (target.kind === 'file') {
      const file = codePathTarget(href, workspace)
      if (file) openPath?.(file.path)
    }
  }

  if (failed) return <CodeBlock code={code} language="mermaid" />

  return (
    <div className="code-block mermaid-block">
      <div className="code-block-header">
        <span className="code-block-lang">mermaid</span>
        <div className="mermaid-actions">
          <button type="button" className="code-copy" onClick={() => setShowSource((value) => !value)} aria-pressed={showSource}>
            {showSource ? 'Diagram' : 'Source'}
          </button>
          <button type="button" className="code-copy" onClick={() => copy(code)} aria-label="Copy diagram source">
            {copied ? <Check size={12} /> : <Copy size={12} />}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
        </div>
      </div>
      <div ref={container} className="mermaid-canvas" hidden={showSource} onClick={openLink} />
      {showSource && <pre><code>{code}</code></pre>}
    </div>
  )
}
