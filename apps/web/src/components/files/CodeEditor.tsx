import { HighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { EditorView, keymap } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import CodeMirror, { type Extension } from '@uiw/react-codemirror'
import { useEffect, useMemo, useState } from 'react'

/**
 * CodeMirror 6 with the app's palette. Every colour is a token from
 * tokens.css, so the editor follows the light and dark themes.
 */
const chrome = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--code-bg)', color: 'var(--text)', fontSize: 'var(--text-sm)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection)' },
  '.cm-gutters': { backgroundColor: 'var(--code-bg)', color: 'var(--text-3)', borderRight: '1px solid var(--code-border)' },
  '.cm-activeLine': { backgroundColor: 'var(--surface-hover)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--surface-hover)', color: 'var(--text-2)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--surface-active)', border: 'none', color: 'var(--text-2)' },
  '.cm-panels': { backgroundColor: 'var(--surface-raised)', color: 'var(--text)' },
  '.cm-searchMatch': { backgroundColor: 'var(--warn-soft)' },
  '.cm-tooltip': { backgroundColor: 'var(--surface-raised)', border: '1px solid var(--border)' },
})

const highlight = syntaxHighlighting(HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword, tags.moduleKeyword, tags.modifier], color: 'var(--syntax-keyword)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.inserted], color: 'var(--syntax-string)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--syntax-number)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName], color: 'var(--syntax-function)' },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.tagName], color: 'var(--syntax-type)' },
  { tag: [tags.propertyName, tags.attributeName, tags.labelName], color: 'var(--syntax-property)' },
  { tag: tags.heading, color: 'var(--syntax-keyword)', fontWeight: '600' },
  { tag: [tags.link, tags.url], color: 'var(--accent-text)', textDecoration: 'underline' },
  { tag: tags.deleted, color: 'var(--danger)' },
  { tag: tags.invalid, color: 'var(--danger)' },
]))

/** The language for a file name, loaded on demand (each grammar is its own chunk). */
function useLanguage(path: string): Extension | undefined {
  const [language, setLanguage] = useState<Extension>()
  useEffect(() => {
    let live = true
    setLanguage(undefined)
    const name = path.slice(path.lastIndexOf('/') + 1)
    const description = LanguageDescription.matchFilename(languages, name)
    void description?.load().then(support => { if (live) setLanguage(support) })
    return () => { live = false }
  }, [path])
  return language
}

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
    chrome,
    highlight,
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
