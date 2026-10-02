import { Download, FileSpreadsheet, FileText, Presentation, ZoomIn, ZoomOut } from 'lucide-react'
import { Suspense, lazy, useEffect, useRef, useState, type ComponentType } from 'react'
import { fetchWorkspaceFile, saveBlob } from '../../lib/api'
import { errorText } from '../../lib/hooks'
import { fileName, officeKind, type OfficeKind } from '../../lib/office'
import { usePreviewZoom, ZOOM_STEPS, type ZoomSetting } from './zoom'

export interface PreviewProps {
  blob: Blob
}

/** Each viewer is its own chunk: the heavy parsers load only when a file of that kind is opened. */
const VIEWERS: Partial<Record<OfficeKind, ComponentType<PreviewProps>>> = {
  xlsx: lazy(() => import('./XlsxPreview')),
  docx: lazy(() => import('./DocxPreview')),
  pptx: lazy(() => import('./PptxPreview')),
}

const ICON: Record<OfficeKind, typeof FileText> = {
  xlsx: FileSpreadsheet,
  docx: FileText,
  pptx: Presentation,
}

/** What "fit" scales to, and where each kind starts: pages and slides fit the pane, sheets open at 100%. */
const FIT: Record<OfficeKind, { measure: string, initial: ZoomSetting }> = {
  docx: { measure: 'section.docx', initial: 'fit' },
  pptx: { measure: '.pptx-canvas', initial: 'fit' },
  xlsx: { measure: '.xlsx-grid', initial: 1 },
}

/** A Workbench document tab that previews an office file, PDF or image from the workspace. */
export function PreviewView({ workspace, path }: { workspace: string; path: string }) {
  const [blob, setBlob] = useState<Blob | undefined>()
  const [error, setError] = useState<string | undefined>()
  const kind = officeKind(path)
  const Viewer = kind ? VIEWERS[kind] : undefined
  const Icon = kind ? ICON[kind] : FileText
  const body = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const fit = FIT[kind ?? 'xlsx']
  const { zoom, setting, setSetting, step } = usePreviewZoom(body, content, fit.measure, fit.initial, blob)

  useEffect(() => {
    const controller = new AbortController()
    setBlob(undefined)
    setError(undefined)
    fetchWorkspaceFile(workspace, path, controller.signal).then(setBlob, reason => {
      if (!controller.signal.aborted) setError(errorText(reason))
    })
    return () => controller.abort()
  }, [workspace, path])

  return (
    <div className="wb-view" aria-label={`Preview ${fileName(path)}`}>
      <div className="wb-toolbar">
        <span className={`office-file-icon small kind-${kind ?? 'other'}`}><Icon size={14} /></span>
        <span className="wb-toolbar-title mono" title={path}>{path}</span>
        {Viewer && (
          <div className="zoom-controls" role="group" aria-label="Zoom">
            <button type="button" className="icon-button" aria-label="Zoom out" title="Zoom out (Ctrl+wheel)" disabled={zoom <= ZOOM_STEPS[0]} onClick={() => step(-1)}>
              <ZoomOut size={15} />
            </button>
            <button
              type="button"
              className="zoom-level"
              title={setting === 'fit' ? 'Fitted to width; click for 100%' : 'Click to fit to width'}
              onClick={() => setSetting(setting === 'fit' ? 1 : 'fit')}
            >
              {setting === 'fit' ? `Fit · ${Math.round(zoom * 100)}%` : `${Math.round(zoom * 100)}%`}
            </button>
            <button type="button" className="icon-button" aria-label="Zoom in" title="Zoom in (Ctrl+wheel)" disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]} onClick={() => step(1)}>
              <ZoomIn size={15} />
            </button>
          </div>
        )}
        <button type="button" className="icon-button small" aria-label="Download" title="Download" disabled={!blob} onClick={() => blob && saveBlob(blob, fileName(path))}>
          <Download size={15} />
        </button>
      </div>
      <div className="wb-card wb-scroll file-preview" ref={body}>
        {error && <div className="notice notice-error"><span>{error}</span></div>}
        {!error && !blob && <div className="file-preview-status"><span className="spinner" /> Loading…</div>}
        {blob && Viewer && (
          <div className="file-preview-content" ref={content} style={{ zoom }}>
            <Suspense fallback={<div className="file-preview-status"><span className="spinner" /> Opening viewer…</div>}>
              <Viewer blob={blob} />
            </Suspense>
          </div>
        )}
        {blob && !Viewer && <NativePreview blob={blob} path={path} />}
      </div>
    </div>
  )
}

/** Images and PDFs need no parser: the page shows them itself. */
function NativePreview({ blob, path }: { blob: Blob; path: string }) {
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    const next = URL.createObjectURL(blob)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [blob])
  if (!url) return null
  if (/\.(png|jpe?g)$/i.test(path)) {
    return <div className="image-preview"><img src={url} alt={fileName(path)} /></div>
  }
  if (/\.pdf$/i.test(path)) {
    return <iframe className="pdf-preview" src={url} title={fileName(path)} />
  }
  return <div className="file-preview-status">No preview for this file type yet. Download it to open it.</div>
}
