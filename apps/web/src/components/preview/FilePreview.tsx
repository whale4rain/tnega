import { Download, FileSpreadsheet, FileText, Presentation, X } from 'lucide-react'
import { Suspense, lazy, useEffect, useState, type ComponentType } from 'react'
import { fetchWorkspaceFile, saveBlob } from '../../lib/api'
import { errorText } from '../../lib/hooks'
import { fileName, officeKind, type OfficeKind } from '../../lib/office'

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

/** Right-hand drawer that previews a file the agent produced, next to the conversation. */
export function FilePreviewDrawer({ workspace, path, onClose }: { workspace: string; path: string; onClose: () => void }) {
  const [blob, setBlob] = useState<Blob | undefined>()
  const [error, setError] = useState<string | undefined>()
  const kind = officeKind(path)
  const Viewer = kind ? VIEWERS[kind] : undefined
  const Icon = kind ? ICON[kind] : FileText

  useEffect(() => {
    const controller = new AbortController()
    setBlob(undefined)
    setError(undefined)
    fetchWorkspaceFile(workspace, path, controller.signal).then(setBlob, reason => {
      if (!controller.signal.aborted) setError(errorText(reason))
    })
    return () => controller.abort()
  }, [workspace, path])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <aside className="drawer file-drawer" aria-label={`Preview ${fileName(path)}`}>
      <header className="drawer-header">
        <span className={`office-file-icon kind-${kind ?? 'other'}`}><Icon size={18} /></span>
        <div className="drawer-titles">
          <div className="drawer-title">{fileName(path)}</div>
          <div className="drawer-sub mono">{path}</div>
        </div>
        <button type="button" className="icon-button" aria-label="Download" title="Download" disabled={!blob} onClick={() => blob && saveBlob(blob, fileName(path))}>
          <Download size={15} />
        </button>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={16} /></button>
      </header>
      <div className="drawer-body file-preview">
        {error && <div className="notice notice-error"><span>{error}</span></div>}
        {!error && !blob && <div className="file-preview-status"><span className="spinner" /> Loading…</div>}
        {blob && Viewer && (
          <Suspense fallback={<div className="file-preview-status"><span className="spinner" /> Opening viewer…</div>}>
            <Viewer blob={blob} />
          </Suspense>
        )}
        {blob && !Viewer && <div className="file-preview-status">No preview for this file type yet. Download it to open it.</div>}
      </div>
    </aside>
  )
}
