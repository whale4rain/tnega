import { EditorView, keymap } from '@codemirror/view'
import CodeMirror from '@uiw/react-codemirror'
import { useMemo } from 'react'
import { editorChrome, editorHighlight, useLanguage } from './editor-theme'

export default function CodeEditor({
  path,
  value,
  readOnly,
  onChange,
  onSave,
}: {
  path: string
  value: string
  readOnly: boolean
  onChange: (value: string) => void
  onSave: () => void
}) {
  const language = useLanguage(path)
  const extensions = useMemo(() => [
    editorChrome,
    editorHighlight,
    EditorView.lineWrapping,
    keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { onSave(); return true } }]),
    ...(language ? [language] : []),
  ], [language, onSave])
  return (
    <CodeMirror
      className="code-editor"
      value={value}
      height="100%"
      theme="none"
      readOnly={readOnly}
      editable={!readOnly}
      extensions={extensions}
      onChange={onChange}
      basicSetup={{ highlightActiveLine: true, foldGutter: true, autocompletion: false }}
      aria-label={`Edit ${path}`}
    />
  )
}
