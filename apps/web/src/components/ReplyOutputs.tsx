import { Check, ChevronRight, File, FileSpreadsheet, FileText, Presentation } from 'lucide-react'
import { useContext, useEffect, useState, type ChangeEvent, type MouseEvent } from 'react'
import { fetchWorkspaceFile } from '../lib/api'
import { LinkContext } from '../lib/links'
import { officeKind } from '../lib/office'
import { formatBytes } from '../lib/project-model'
import { formatAction, initialValues, isInteractive, parseAction, type A2uiComponent, type A2uiSurface, type A2uiValue, type ReplyItem, type SentFile } from '../lib/reply'
import { useFileMenu } from './FileMenu'
import { ImageViewer } from './ImageStrip'

/**
 * What a turn handed over besides words (tnega-design §5.1): images the agent
 * sent show inline, other files as cards that open in the Workbench, and an
 * agent-rendered interface (A2UI) as a small form under the answer.
 */
export function ReplyOutputs({ items, onOpen, answerable, answer, onAction }: {
  items: readonly ReplyItem[]
  onOpen?: ((path: string) => void) | undefined
  /** The newest turn, idle: its form still waits for the person. */
  answerable: boolean
  /** The user message that answered a form in this turn, if one did. */
  answer?: string | undefined
  onAction?: ((text: string) => void) | undefined
}) {
  return (
    <div className="reply-outputs">
      {items.map(item => item.kind === 'files'
        ? <SentFiles key={item.id} files={item.files} onOpen={onOpen} />
        : <UiSurface key={item.id} id={item.id} surface={item.surface} answerable={answerable} answer={answer} onAction={onAction} />)}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Files

/** The bytes of a workspace file as an object URL, freed when the view goes. */
function useWorkspaceUrl(path: string): { url?: string; failed: boolean } {
  const { workspace } = useContext(LinkContext)
  const [state, setState] = useState<{ url?: string; failed: boolean }>({ failed: false })
  useEffect(() => {
    if (!workspace) {
      setState({ failed: true })
      return
    }
    const controller = new AbortController()
    let url: string | undefined
    setState({ failed: false })
    fetchWorkspaceFile(workspace, path, controller.signal).then(blob => {
      url = URL.createObjectURL(blob)
      setState({ url, failed: false })
    }, () => {
      if (!controller.signal.aborted) setState({ failed: true })
    })
    return () => {
      controller.abort()
      if (url) URL.revokeObjectURL(url)
    }
  }, [workspace, path])
  return state
}

function SentFiles({ files, onOpen }: { files: readonly SentFile[]; onOpen?: ((path: string) => void) | undefined }) {
  const { show, menu } = useFileMenu()
  const images = files.filter(file => file.kind === 'image')
  const others = files.filter(file => file.kind !== 'image')
  return (
    <>
      {menu}
      {images.length > 0 && (
        <div className="reply-images">
          {images.map(file => <SentImage key={file.path} file={file} onOpen={onOpen} onMenu={show} />)}
        </div>
      )}
      {others.length > 0 && (
        <div className="office-files">
          {others.map(file => <FileCard key={file.path} file={file} onOpen={onOpen} onMenu={show} />)}
        </div>
      )}
    </>
  )
}

type MenuHandler = (event: MouseEvent<HTMLElement>, path: string) => void

function SentImage({ file, onOpen, onMenu }: { file: SentFile; onOpen?: ((path: string) => void) | undefined; onMenu: MenuHandler }) {
  const { url, failed } = useWorkspaceUrl(file.path)
  const [open, setOpen] = useState(false)
  // A file moved or deleted since: still say what was sent, as a card.
  if (failed) return <FileCard file={file} onOpen={onOpen} onMenu={onMenu} />
  return (
    <>
      <button
        type="button"
        className={`reply-image${url ? '' : ' is-loading'}`}
        aria-label={`Open ${file.name}`}
        title={file.path}
        onClick={() => setOpen(true)}
        onContextMenu={event => onMenu(event, file.path)}
        disabled={!url}
      >
        {url ? <img src={url} alt={file.name} /> : <span className="reply-image-placeholder" aria-hidden />}
      </button>
      {open && url && <ImageViewer src={url} name={file.name} onClose={() => setOpen(false)} />}
    </>
  )
}

function FileCard({ file, onOpen, onMenu }: { file: SentFile; onOpen?: ((path: string) => void) | undefined; onMenu: MenuHandler }) {
  const office = officeKind(file.path)
  const extension = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toUpperCase()
  const Icon = office === 'xlsx' ? FileSpreadsheet : office === 'pptx' ? Presentation : office || extension === 'PDF' || extension === 'MD' ? FileText : File
  const folder = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''
  const meta = [extension, formatBytes(file.size), folder].filter(Boolean).join(' · ')
  return (
    <button type="button" className={`office-file kind-${office ?? 'other'}`} onClick={() => onOpen?.(file.path)} onContextMenu={event => onMenu(event, file.path)} disabled={!onOpen} title={`Open ${file.path}`} aria-label={`Open ${file.name}`}>
      <span className="office-file-icon"><Icon size={18} /></span>
      <span className="office-file-text">
        <span className="office-file-name">{file.name}</span>
        <span className="office-file-meta">{meta}</span>
      </span>
      <ChevronRight size={14} className="office-file-chevron" />
    </button>
  )
}

// ---------------------------------------------------------------------------
// Agent-rendered UI (A2UI subset)

type Values = Record<string, A2uiValue>

interface SurfaceState {
  values: Values
  set: (key: string, value: A2uiValue) => void
  disabled: boolean
  /** The action already sent from this surface. */
  sent?: string
  press: (action: string, label: string) => void
}

function UiSurface({ id, surface, answerable, answer, onAction }: {
  id: string
  surface: A2uiSurface
  answerable: boolean
  answer?: string | undefined
  onAction?: ((text: string) => void) | undefined
}) {
  const answered = answer ? parseAction(answer) : undefined
  const mine = answered?.surface === id ? answered : undefined
  const [values, setValues] = useState<Values>(() => ({ ...initialValues(surface), ...mine?.values }))
  const [pressed, setPressed] = useState<string | undefined>()
  const waits = isInteractive(surface)
  const sent = mine?.label ?? pressed
  const disabled = !waits || !answerable || !onAction || sent !== undefined
  const state: SurfaceState = {
    values,
    set: (key, value) => setValues(current => ({ ...current, [key]: value })),
    disabled,
    ...(sent !== undefined ? { sent } : {}),
    press: (action, label) => {
      if (disabled) return
      setPressed(label)
      onAction?.(formatAction({ surface: id, action, label, values }))
    },
  }
  return (
    <section className="a2ui-surface" aria-label={surface.title ?? 'Form from the agent'}>
      {surface.title && <div className="a2ui-title">{surface.title}</div>}
      <UiNode id={surface.root} surface={surface} state={state} />
      {waits && sent !== undefined && (
        <div className="a2ui-foot"><Check size={12} aria-hidden />Sent · {sent}</div>
      )}
      {waits && sent === undefined && !answerable && (
        <div className="a2ui-foot">No longer waiting for an answer</div>
      )}
    </section>
  )
}

function UiNode({ id, surface, state }: { id: string; surface: A2uiSurface; state: SurfaceState }) {
  const node = surface.components[id]
  if (!node) return null
  return <UiComponent node={node} surface={surface} state={state} />
}

function UiComponent({ node, surface, state }: { node: A2uiComponent; surface: A2uiSurface; state: SurfaceState }) {
  switch (node.component) {
    case 'Column':
    case 'Row':
    case 'Card':
      return (
        <div className={`a2ui-${node.component.toLowerCase()}`}>
          {node.children.map(child => <UiNode key={child} id={child} surface={surface} state={state} />)}
        </div>
      )
    case 'Text':
      return <div className={`a2ui-text variant-${node.variant}`}>{node.text}</div>
    case 'Image':
      return <UiImage src={node.src} alt={node.alt ?? ''} />
    case 'Divider':
      return <hr className="a2ui-divider" />
    case 'TextField': {
      const value = state.values[node.path]
      const text = typeof value === 'string' ? value : ''
      const input = {
        value: text,
        disabled: state.disabled,
        placeholder: node.placeholder,
        'aria-label': node.label ?? node.placeholder ?? node.path,
        onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => state.set(node.path, event.target.value),
      }
      return (
        <label className="field a2ui-field">
          {node.label && <span className="field-label">{node.label}</span>}
          {node.multiline ? <textarea rows={3} {...input} /> : <input type="text" {...input} />}
        </label>
      )
    }
    case 'CheckBox':
      return (
        <label className="field-check a2ui-check">
          <input type="checkbox" checked={state.values[node.path] === true} disabled={state.disabled} onChange={event => state.set(node.path, event.target.checked)} />
          <span>{node.label}</span>
        </label>
      )
    case 'ChoicePicker': {
      const value = state.values[node.path]
      const chosen = new Set(Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : [])
      const name = `a2ui-${node.id}`
      const pick = (option: string, checked: boolean) => {
        if (!node.multiple) return state.set(node.path, option)
        const next = new Set(chosen)
        if (checked) next.add(option)
        else next.delete(option)
        state.set(node.path, node.options.map(each => each.value).filter(each => next.has(each)))
      }
      return (
        <fieldset className="a2ui-choices" disabled={state.disabled}>
          {node.label && <legend className="field-label">{node.label}</legend>}
          <div className="question-options">
            {node.options.map(option => {
              const selected = chosen.has(option.value)
              return (
                <label key={option.value} className={`question-option${selected ? ' selected' : ''}`}>
                  <input type={node.multiple ? 'checkbox' : 'radio'} name={name} checked={selected} onChange={event => pick(option.value, event.target.checked)} />
                  <span>{option.label}</span>
                </label>
              )
            })}
          </div>
        </fieldset>
      )
    }
    case 'Button':
      return (
        <button
          type="button"
          className={`button small ${node.variant === 'secondary' ? 'secondary' : 'primary'}`}
          disabled={state.disabled}
          aria-pressed={state.sent === node.label ? true : undefined}
          onClick={() => state.press(node.action, node.label)}
        >
          {node.label}
        </button>
      )
  }
}

function UiImage({ src, alt }: { src: string; alt: string }) {
  const { url, failed } = useWorkspaceUrl(src.replace(/^\.\//, ''))
  if (failed) return <div className="a2ui-text variant-caption">Image not found: {src}</div>
  return url ? <img className="a2ui-image" src={url} alt={alt} /> : <span className="reply-image-placeholder a2ui-image" aria-hidden />
}
