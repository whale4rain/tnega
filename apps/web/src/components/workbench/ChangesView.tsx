import { Columns2, FileCode2, GitBranch, RefreshCw, Rows2 } from 'lucide-react'
import { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import { errorText } from '../../lib/hooks'
import type { Focus } from '../../lib/workbench'
import { workbenchApi, type ChangedFile, type ChangeStatus, type ChangeSummary, type FileDiff } from '../../lib/workbench-api'

const DiffEditor = lazy(() => import('./DiffEditor'))

const STATUS: Record<ChangeStatus, { letter: string; label: string }> = {
  modified: { letter: 'M', label: 'Modified' },
  added: { letter: 'A', label: 'Added' },
  untracked: { letter: 'U', label: 'New, untracked' },
  deleted: { letter: 'D', label: 'Deleted' },
  renamed: { letter: 'R', label: 'Renamed' },
}

const POLL_MS = 5000
const PREVIEWABLE = /\.(png|jpe?g|pdf|docx|xlsx|pptx)$/i

/**
 * What changed in the workspace since the last commit — yours and the agent's
 * alike — as a file list beside a diff. It refreshes while visible, so the
 * agent's edits appear as they land.
 */
export function ChangesView({
  workspace,
  visible,
  focus,
  onOpenInFiles,
  onPreview,
  onCount,
}: {
  workspace: string
  visible: boolean
  focus: Focus | undefined
  onOpenInFiles: (path: string) => void
  /** Open a binary file (image, PDF, Office document) as a preview tab. */
  onPreview: (path: string) => void
  onCount?: (count: number) => void
}) {
  const [summary, setSummary] = useState<ChangeSummary>()
  const [error, setError] = useState<string>()
  const [selected, setSelected] = useState<string>()
  const [diff, setDiff] = useState<FileDiff>()
  const [layout, setLayout] = useState<'unified' | 'split'>(() => localStorage.getItem('tnega.diffLayout') === 'split' ? 'split' : 'unified')

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await workbenchApi.changes(workspace, signal)
      setSummary(next)
      setError(undefined)
      onCount?.(next.files.length)
    } catch (reason) {
      if (!signal?.aborted) setError(errorText(reason))
    }
  }, [workspace, onCount])

  useEffect(() => {
    if (!visible) return
    const controller = new AbortController()
    void refresh(controller.signal)
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(controller.signal) }, POLL_MS)
    return () => { controller.abort(); clearInterval(timer) }
  }, [visible, refresh])

  useEffect(() => {
    if (focus?.tool === 'changes') setSelected(focus.path)
  }, [focus])

  // Keep a selection while there are changes; follow the list when the selected file is committed away.
  const files = summary?.files
  useEffect(() => {
    if (!files?.length) return
    if (!selected || !files.some(file => file.path === selected)) setSelected(files[0]!.path)
  }, [files, selected])

  // Reload the open diff whenever the summary changes (the file may have changed again).
  const current = files?.find(file => file.path === selected)
  const stamp = current ? `${current.path}:${current.status}:${current.additions}:${current.deletions}` : ''
  useEffect(() => {
    if (!selected || !stamp) {
      setDiff(undefined)
      return
    }
    const controller = new AbortController()
    workbenchApi.diff(workspace, selected, controller.signal).then(setDiff, reason => {
      if (!controller.signal.aborted) setError(errorText(reason))
    })
    return () => controller.abort()
  }, [workspace, selected, stamp])

  const changeLayout = (next: 'unified' | 'split') => {
    setLayout(next)
    localStorage.setItem('tnega.diffLayout', next)
  }

  const totals = (files ?? []).reduce((sum, file) => ({ add: sum.add + (file.additions ?? 0), del: sum.del + (file.deletions ?? 0) }), { add: 0, del: 0 })
  return (
    <div className="wb-view">
      <div className="wb-toolbar">
        <span className="wb-toolbar-title">
          {summary?.branch && <span className="wb-chip"><GitBranch size={12} />{summary.branch}</span>}
          {files && (
            <span className="muted small">
              {files.length === 1 ? '1 file' : `${files.length} files`}
              {files.length > 0 && <> · <span className="diff-add">+{totals.add}</span> <span className="diff-del">−{totals.del}</span></>}
            </span>
          )}
        </span>
        <div className="segmented small" role="group" aria-label="Diff layout">
          <button type="button" className={layout === 'unified' ? 'active' : ''} aria-pressed={layout === 'unified'} title="Unified" aria-label="Unified diff" onClick={() => changeLayout('unified')}><Rows2 size={14} /></button>
          <button type="button" className={layout === 'split' ? 'active' : ''} aria-pressed={layout === 'split'} title="Side by side" aria-label="Side-by-side diff" onClick={() => changeLayout('split')}><Columns2 size={14} /></button>
        </div>
        {current && current.status !== 'deleted' && (
          <button type="button" className="icon-button small" title="Open in Files" aria-label="Open in Files" onClick={() => onOpenInFiles(current.path)}>
            <FileCode2 size={14} />
          </button>
        )}
        <button type="button" className="icon-button small" title="Refresh" aria-label="Refresh changes" onClick={() => void refresh()}>
          <RefreshCw size={14} />
        </button>
      </div>
      <div className="wb-card wb-split">
        {error && <div className="notice notice-error wb-notice" role="alert"><span>{error}</span></div>}
        {summary && !summary.git && (
          <div className="wb-empty">
            <GitBranch size={18} />
            <p>This workspace is not a git repository. Each turn still lists the files it changed in the conversation.</p>
          </div>
        )}
        {summary?.git && files?.length === 0 && (
          <div className="wb-empty">
            <GitBranch size={18} />
            <p>No changes since the last commit. Edits from you or the agent appear here as they happen.</p>
          </div>
        )}
        {!summary && !error && <div className="file-preview-status"><span className="spinner" /> Reading changes…</div>}
        {files && files.length > 0 && (
          <>
            <nav className="wb-list" aria-label="Changed files">
              {files.map(file => <ChangeRow key={file.path} file={file} selected={file.path === selected} onSelect={() => setSelected(file.path)} />)}
              {summary?.truncated && <p className="muted small wb-list-note">Showing the first {files.length} files.</p>}
            </nav>
            <section className="wb-detail">
              {(!diff || diff.path !== selected) && <div className="file-preview-status"><span className="spinner" /> Opening diff…</div>}
              {diff && diff.path === selected && diff.reason && (
                <div className="file-preview-status">
                  {diff.reason === 'binary' ? 'Binary file — no text diff.' : 'Too large to diff here.'}
                  {PREVIEWABLE.test(diff.path) && diff.status !== 'deleted' && (
                    <button type="button" className="button ghost small" onClick={() => onPreview(diff.path)}>Open preview</button>
                  )}
                </div>
              )}
              {diff && diff.path === selected && !diff.reason && (
                <Suspense fallback={<div className="file-preview-status"><span className="spinner" /> Opening diff…</div>}>
                  <DiffEditor key={`${diff.path}:${layout}`} path={diff.path} original={diff.original ?? ''} modified={diff.modified ?? ''} layout={layout} />
                </Suspense>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  )
}

function ChangeRow({ file, selected, onSelect }: { file: ChangedFile; selected: boolean; onSelect: () => void }) {
  const slash = file.path.lastIndexOf('/')
  const name = file.path.slice(slash + 1)
  const dir = slash > 0 ? file.path.slice(0, slash) : ''
  const status = STATUS[file.status]
  return (
    <button type="button" className={`wb-row change-row${selected ? ' selected' : ''}`} onClick={onSelect} title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}>
      <span className={`change-status status-${file.status}`} aria-label={status.label}>{status.letter}</span>
      <span className="change-name">{name}</span>
      <span className="change-dir">{dir}</span>
      {file.binary
        ? <span className="muted small">bin</span>
        : (
          <span className="change-stat">
            {(file.additions ?? 0) > 0 && <span className="diff-add">+{file.additions}</span>}
            {(file.deletions ?? 0) > 0 && <span className="diff-del">−{file.deletions}</span>}
          </span>
        )}
    </button>
  )
}
