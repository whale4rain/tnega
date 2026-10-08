import { PanelLeftClose, PanelLeftOpen, RefreshCw, Save } from 'lucide-react'
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, type TextFile } from '../../lib/api'
import { errorText, folderName, useStoredState } from '../../lib/hooks'
import type { Focus } from '../../lib/workbench'
import { officeKind } from '../../lib/office'
import { confirmDialog } from '../../lib/dialogs'
import { FileTree, type FileTreeHandle } from '../files/FileTree'

/** CodeMirror and its grammars load only when a file is first opened. */
const CodeEditor = lazy(() => import('../files/CodeEditor'))

interface OpenFile {
  file: TextFile
  draft: string
}

/**
 * Workbench Files: the workspace tree beside an editor. Text files open in
 * CodeMirror and save with Ctrl+S; a save over a newer change on disk (say,
 * the agent edited the file meanwhile) is refused rather than overwriting it.
 * Office documents, PDFs and images open as preview tabs.
 */
export function FilesView({
  workspace,
  focus,
  onPreview,
  onDirtyChange,
}: {
  workspace: string
  focus: Focus | undefined
  onPreview: (path: string) => void
  onDirtyChange?: (dirty: boolean) => void
}) {
  const [open, setOpen] = useState<OpenFile>()
  const [loading, setLoading] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const tree = useRef<FileTreeHandle>(null)
  // The tree stays mounted while hidden so its expanded folders survive.
  const [treeMode, setTreeMode] = useStoredState<'shown' | 'hidden'>('tnega.filesTree', 'shown', ['shown', 'hidden'])
  const treeHidden = treeMode === 'hidden'
  const dirty = open !== undefined && open.file.content !== undefined && open.draft !== open.file.content

  const confirmDiscard = useCallback(async () => !dirty || await confirmDialog({
    title: 'Discard unsaved changes?',
    ...(open ? { message: `Your edits to ${open.file.path} will be lost.` } : {}),
    confirmLabel: 'Discard',
    danger: true,
  }), [dirty, open])

  const openFile = useCallback(async (path: string) => {
    if (path === open?.file.path || !await confirmDiscard()) return
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
    if (!open || !await confirmDiscard()) return
    setError(undefined)
    try {
      const file = await api.readText(workspace, open.file.path)
      setOpen({ file, draft: file.content ?? '' })
    } catch (reason) {
      setError(errorText(reason))
    }
    tree.current?.refresh()
  }, [workspace, open, confirmDiscard])

  // Another tool asked to show a file here (Changes → "Open in Files").
  const lastFocus = useRef(0)
  useEffect(() => {
    if (focus?.tool !== 'files' || focus.nonce === lastFocus.current) return
    lastFocus.current = focus.nonce
    void openFile(focus.path)
  }, [focus, openFile])

  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])

  const file = open?.file
  return (
    <div className="wb-view">
      <div className="wb-toolbar">
        <button
          type="button"
          className="icon-button small"
          aria-label={treeHidden ? 'Show file tree' : 'Hide file tree'}
          aria-pressed={!treeHidden}
          title={treeHidden ? 'Show file tree' : 'Hide file tree'}
          onClick={() => setTreeMode(treeHidden ? 'shown' : 'hidden')}
        >
          {treeHidden ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
        </button>
        <span className="wb-toolbar-title mono" title={file?.path ?? workspace}>
          {file ? file.path : folderName(workspace)}
          {dirty && <span className="dirty-dot" aria-label="Unsaved changes" />}
        </span>
        <button type="button" className="icon-button small" aria-label="Reload from disk" title="Reload from disk" onClick={() => file ? void reload() : tree.current?.refresh()}>
          <RefreshCw size={14} />
        </button>
        {file?.content !== undefined && (
          <button type="button" className="button primary small" disabled={!dirty || saving} onClick={() => void save()} title="Save (Ctrl+S)">
            <Save size={12} />{saving ? 'Saving…' : 'Save'}
          </button>
        )}
      </div>
      <div className={`wb-card wb-split${treeHidden ? ' tree-hidden' : ''}`}>
        <nav className="wb-list files-tree-pane" aria-label="Workspace tree" hidden={treeHidden}>
          <FileTree ref={tree} workspace={workspace} selected={file?.path} onOpen={path => void openFile(path)} />
        </nav>
        <section className="wb-detail files-editor-pane">
          {error && <div className="notice notice-error wb-notice" role="alert"><span>{error}</span></div>}
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
    </div>
  )
}
