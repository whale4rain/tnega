import { MergeView, unifiedMergeView } from '@codemirror/merge'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { useEffect, useRef } from 'react'
import { editorChrome, editorHighlight, useLanguage } from '../files/editor-theme'

/**
 * A read-only diff in the editor's own palette: unified (one column, deleted
 * lines shown inline) or split (before | after). Long unchanged stretches
 * collapse, as in a code review.
 */
export default function DiffEditor({
  path,
  original,
  modified,
  layout,
}: {
  path: string
  original: string
  modified: string
  layout: 'unified' | 'split'
}) {
  const host = useRef<HTMLDivElement>(null)
  const language = useLanguage(path)

  useEffect(() => {
    const parent = host.current
    if (!parent) return
    const shared = [
      basicSetup,
      editorChrome,
      editorHighlight,
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      ...(language ? [language] : []),
    ]
    const collapse = { margin: 3, minSize: 6 }
    if (layout === 'split') {
      const view = new MergeView({
        a: { doc: original, extensions: shared },
        b: { doc: modified, extensions: shared },
        parent,
        collapseUnchanged: collapse,
        gutter: true,
      })
      return () => view.destroy()
    }
    const view = new EditorView({
      parent,
      doc: modified,
      extensions: [...shared, unifiedMergeView({ original, mergeControls: false, collapseUnchanged: collapse })],
    })
    return () => view.destroy()
  }, [original, modified, layout, language])

  return <div className={`diff-editor diff-${layout}`} ref={host} aria-label={`Changes in ${path}`} />
}
