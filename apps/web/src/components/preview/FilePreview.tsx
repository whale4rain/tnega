import { Download } from 'lucide-react'
import { Suspense, lazy, useEffect, useState, type ComponentType } from 'react'
import { fetchWorkspaceFile, saveBlob } from '../../lib/api'
import { errorText } from '../../lib/hooks'
import { fileName, officeKind, type OfficeKind } from '../../lib/office'
import { Dialog } from '../Dialog'

export interface PreviewProps {
  blob: Blob
}

/** Each viewer is its own chunk: the heavy parsers load only when a file of that kind is opened. */
const VIEWERS: Partial<Record<OfficeKind, ComponentType<PreviewProps>>> = {
  xlsx: lazy(() => import('./XlsxPreview')),
  docx: lazy(() => import('./DocxPreview')),
}

const LABEL: Record<OfficeKind, string> = {
  xlsx: 'Excel workbook',
  docx: 'Word document',
  pptx: 'PowerPoint presentation',
}

export function FilePreviewDialog({ workspace, path, onClose }: { workspace: string; path: string; onClose: () => void }) {
  const [blob, setBlob] = useState<Blob | undefined>()
  const [error, setError] = useState<string | undefined>()
  const kind = officeKind(path)
  const Viewer = kind ? VIEWERS[kind] : undefined

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
    <Dialog
      title={fileName(path)}
      description={<>{kind ? LABEL[kind] : 'File'} · <span className="mono">{path}</span></>}
      onClose={onClose}
      width={1040}
      footer={(
        <button type="button" className="button secondary small" disabled={!blob} onClick={() => blob && saveBlob(blob, fileName(path))}>
          <Download size={14} /> Download
        </button>
      )}
    >
      <div className="file-preview">
        {error && <div className="notice notice-error"><span>{error}</span></div>}
        {!error && !blob && <div className="file-preview-status"><span className="spinner" /> Loading…</div>}
        {blob && Viewer && (
          <Suspense fallback={<div className="file-preview-status"><span className="spinner" /> Opening viewer…</div>}>
            <Viewer blob={blob} />
          </Suspense>
        )}
        {blob && !Viewer && <div className="file-preview-status">No preview for this file type yet. Download it to open it.</div>}
      </div>
    </Dialog>
  )
}
