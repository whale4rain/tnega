import { ChevronRight, FileSpreadsheet, FileText, Presentation } from 'lucide-react'
import { fileName, type OfficeFile, type OfficeKind } from '../lib/office'
import { useFileMenu } from './FileMenu'

const ICON: Record<OfficeKind, typeof FileText> = {
  xlsx: FileSpreadsheet,
  docx: FileText,
  pptx: Presentation,
}

export function OfficeFiles({ files, onOpen }: { files: readonly OfficeFile[]; onOpen?: ((path: string) => void) | undefined }) {
  const { show, menu } = useFileMenu()
  return (
    <div className="office-files">
      {menu}
      {files.map(file => {
        const Icon = ICON[file.kind]
        const folder = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''
        return (
          <button key={file.path} type="button" className={`office-file kind-${file.kind}`} onClick={() => onOpen?.(file.path)} onContextMenu={event => show(event, file.path)} disabled={!onOpen} title={`Preview ${file.path}`}>
            <span className="office-file-icon"><Icon size={18} /></span>
            <span className="office-file-text">
              <span className="office-file-name">{fileName(file.path)}</span>
              <span className="office-file-meta">{file.kind.toUpperCase()}{folder ? ` · ${folder}` : ''}</span>
            </span>
            <ChevronRight size={14} className="office-file-chevron" />
          </button>
        )
      })}
    </div>
  )
}
