import { FolderTree, RefreshCw, Save, X } from 'lucide-react'
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, type TextFile } from '../../lib/api'
import { errorText, folderName } from '../../lib/hooks'
import { officeKind } from '../../lib/office'
import { FileTree, type FileTreeHandle } from './FileTree'

/** CodeMirror and its grammars load only when a file is first opened. */
const CodeEditor = lazy(() => import('./CodeEditor'))

interface OpenFile {
  file: TextFile
  draft: string
}

/**
 * Right-hand Files panel: the workspace tree beside an editor. Text files open
 * in CodeMirror and save with Ctrl+S; a save over a newer change on disk (say,
 * the agent edited the file meanwhile) is refused rather than overwriting it.
 * Office documents, PDFs and images hand off to the existing preview drawer.
 */
export function FilesDrawer({
  workspace,
  onClose,
  onPreview,
}: {
  workspace: string
  onClose: () => void
  onPreview: (path: string) => void
}) {
  const [open, setOpen] = useState<OpenFile>()
  const [loading, setLoading] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const tree = useRef<FileTreeHandle>(null)
  const dirty = open !== undefined && open.file.content !== undefined && open.draft !== open.file.content

  const confirmDiscard = useCallback(() => !dirty || window.confirm(`Discard unsaved changes to ${open?.file.path}?`), [dirty, open])

  const openFile = useCallback(async (path: string) => {
    if (path === open?.file.path || !confirmDiscard()) return
    if (officeKind(path) || /\.(pdf|png|jpe?g)$/i.test(path)) {
      onPreview(path)
      return
    }
    setLoading(path)
    setError(undefined)
    try {
      const file = await api.readText(workspace, path)
      setOpen({ file, draft: file.content ?? '' })
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setLoading(undefined)
    }
  }, [workspace, open, confirmDiscard, onPreview])

  const save = useCallback(async () => {
    if (!open || !dirty || saving) return
    setSaving(true)
    setError(undefined)
    try {
      const file = await api.writeText(workspace, open.file.path, open.draft, open.file.mtimeMs)
      setOpen(current => current && current.file.path === file.path ? { file, draft: current.draft } : current)
    } catch (reason) {
      setError(reason instanceof ApiError && reason.status === 409
        ? `${open.file.path} changed on disk since you opened it. Reload it to see the new version; your edits stay here until you do.`
        : errorText(reason))
    } finally {
      setSaving(false)
    }
  }, [workspace, open, dirty, saving])

  const reload = useCallback(async () => {
    if (!open || !confirmDiscard()) return
    setError(undefined)
    try {
      const file = await api.readText(workspace, open.file.path)
      setOpen({ file, draft: file.content ?? '' })
    } catch (reason) {
      setError(errorText(reason))
    }
    tree.current?.refresh()
  }, [workspace, open, confirmDiscard])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && confirmDiscard()) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, confirmDiscard])

  const file = open?.file
  return (
    <aside className="drawer files-drawer" aria-label="Files">
      <header className="drawer-header">
        <span className="files-drawer-icon"><FolderTree size={17} /></span>
        <div className="drawer-titles">
          <div className="drawer-title">{file ? file.path.slice(file.path.lastIndexOf('/') + 1) : 'Files'}{dirty && <span className="dirty-dot" aria-label="Unsaved changes" />}</div>
          <div className="drawer-sub mono">{file ? file.path : folderName(workspace)}</div>
        </div>
        <button type="button" className="icon-button" aria-label="Reload from disk" title="Reload from disk" onClick={() => file ? void reload() : tree.current?.refresh()}>
          <RefreshCw size={15} />
        </button>
        {file?.content !== undefined && (
          <button type="button" className="button primary small" disabled={!dirty || saving} onClick={() => void save()} title="Save (Ctrl+S)">
            <Save size={13} />{saving ? 'Saving…' : 'Save'}
          </button>
        )}
        <button type="button" className="icon-button" onClick={() => confirmDiscard() && onClose()} aria-label="Close"><X size={16} /></button>
      </header>
      <div className="files-body">
        <nav className="files-tree-pane" aria-label="Workspace tree">
          <FileTree ref={tree} workspace={workspace} selected={file?.path} onOpen={path => void openFile(path)} />
        </nav>
        <section className="files-editor-pane">
          {error && <div className="notice notice-error files-error" role="alert"><span>{error}</span></div>}
          {loading && <div className="file-preview-status"><span className="spinner" /> Opening {loading}…</div>}
          {!loading && !file && <div className="file-preview-status">Pick a file to read or edit it.</div>}
          {!loading && file?.reason === 'binary' && <div className="file-preview-status">{file.path} is a binary file.</div>}
          {!loading && file?.reason === 'too-large' && <div className="file-preview-status">{file.path} is too large to open here ({Math.round(file.size / 1024)} KB).</div>}
          {!loading && file?.content !== undefined && open && (
            <Suspense fallback={<div className="file-preview-status"><span className="spinner" /> Opening editor…</div>}>
              <CodeEditor
                key={file.path}
                path={file.path}
                value={open.draft}
                readOnly={false}
                onChange={draft => setOpen(current => current && { ...current, draft })}
                onSave={() => void save()}
              />
            </Suspense>
          )}
        </section>
      </div>
    </aside>
  )
}
