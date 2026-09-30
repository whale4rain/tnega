import { ChevronRight, FileSpreadsheet, FileText, Presentation } from 'lucide-react'
import { fileName, type OfficeFile, type OfficeKind } from '../lib/office'

const ICON: Record<OfficeKind, typeof FileText> = {
  xlsx: FileSpreadsheet,
  docx: FileText,
  pptx: Presentation,
}

export function OfficeFiles({ files, onOpen }: { files: readonly OfficeFile[]; onOpen?: ((path: string) => void) | undefined }) {
  return (
    <div className="office-files">
      {files.map(file => {
        const Icon = ICON[file.kind]
        const folder = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''
        return (
          <button key={file.path} type="button" className={`office-file kind-${file.kind}`} onClick={() => onOpen?.(file.path)} disabled={!onOpen} title={`Preview ${file.path}`}>
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
