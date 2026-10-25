import { memo, useContext, type MouseEvent, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { codePathTarget, LinkContext, linkTarget } from '../lib/links'
import { CodeBlock } from './CodeBlock'
import { MermaidDiagram } from './MermaidDiagram'
import { StatusLight } from './StatusLight'
import { useFileMenu } from './FileMenu'

export { CodeBlock }

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node && typeof node === 'object' && 'props' in node) {
    return textOf((node.props as { children?: ReactNode }).children)
  }
  return ''
}

const components: Components = {
  p({ children }) { return <p><FileReferences>{children}</FileReferences></p> },
  li({ children }) { return <li><FileReferences>{children}</FileReferences></li> },
  strong({ children }) { return <strong><FileReferences>{children}</FileReferences></strong> },
  em({ children }) { return <em><FileReferences>{children}</FileReferences></em> },
  td({ children }) { return <td><FileReferences>{children}</FileReferences></td> },
  pre({ children }) {
    const child = Array.isArray(children) ? children[0] : children
    const className = child && typeof child === 'object' && 'props' in child
      ? (child.props as { className?: string }).className
      : undefined
    const language = className?.match(/language-([\w+-]+)/)?.[1]
    const code = textOf(children).replace(/\n$/, '')
    if (language === 'mermaid') return <MermaidDiagram code={code} />
    return <CodeBlock code={code} language={language} />
  },
  a({ href, children }) {
    return <SmartLink href={href}>{children}</SmartLink>
  },
  code({ className, children }) {
    // Fenced blocks are handled by `pre`; this is inline code.
    if (className) return <code className={className}>{children}</code>
    return <InlineCode text={textOf(children)}>{children}</InlineCode>
  },
  table({ children }) {
    return <div className="table-scroll"><table>{children}</table></div>
  },
}

/**
 * The default sanitizer reads `app.ts:42` as an unknown `app.ts:` scheme and
 * drops the link; file references keep theirs. Everything else is sanitized
 * as before (no `javascript:`).
 */
function urlTransform(url: string): string {
  return linkTarget(url).kind === 'file' ? url : defaultUrlTransform(url)
}

/**
 * A link that opens where it belongs: workspace files and local dev servers
 * in the Workbench, everything else in a new tab (the desktop app hands
 * those to the system browser).
 */
function SmartLink({ href, children }: { href: string | undefined; children: ReactNode }) {
  const { workspace, openPath, openLocalUrl, thread } = useContext(LinkContext)
  const target = linkTarget(href, workspace)
  if (target.kind === 'thread') {
    const info = thread?.(target.id)
    // Outside a project, or a thread that no longer exists: keep the words, drop the link.
    if (!info) return <span>{children}</span>
    const open = (event: MouseEvent) => { event.preventDefault(); info.open() }
    return (
      <a href={href} className={`thread-link light-${info.tone}`} title={`Open thread ${info.label} · ${info.status}`} onClick={open}>
        <StatusLight tone={info.tone} label={info.status} />
        {children}
      </a>
    )
  }
  if (target.kind === 'file') {
    if (!openPath) return <span className="file-ref" title={target.path}>{children}</span>
    return <FileLink path={target.path} title={`Open ${target.path}${target.line ? ` (line ${target.line})` : ''}`} open={openPath}>{children}</FileLink>
  }
  if (target.kind === 'local' && openLocalUrl) {
    const open = (event: MouseEvent) => { event.preventDefault(); openLocalUrl(target.url) }
    return <a href={target.url} title={`Open ${target.url} in the browser`} onClick={open}>{children}</a>
  }
  return <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>
}

function InlineCode({ text, children }: { text: string; children: ReactNode }) {
  const { workspace, openPath } = useContext(LinkContext)
  const target = openPath ? codePathTarget(text, workspace) : undefined
  if (!target || !openPath) return <code>{children}</code>
  return <FileLink path={target.path} title={`Open ${target.path}`} open={openPath} code><code>{children}</code></FileLink>
}

/** A workspace file in a reply: a click opens it where it belongs, a right-click offers the rest (FileMenu). */
function FileLink({ path, title, open, code, children }: { path: string; title: string; open: (path: string) => void; code?: boolean; children: ReactNode }) {
  const { show, menu } = useFileMenu()
  return (
    <>
      <a
        href={path}
        className={`file-link${code ? ' code-link' : ''}`}
        title={title}
        onClick={(event: MouseEvent) => { event.preventDefault(); open(path) }}
        onContextMenu={event => show(event, path)}
      >
        {children}
      </a>
      {menu}
    </>
  )
}

/** Link plain file references without traversing code blocks or existing anchors. */
function FileReferences({ children }: { children: ReactNode }) {
  const { workspace, openPath } = useContext(LinkContext)
  if (!openPath) return children
  const render = (child: ReactNode): ReactNode => {
    if (Array.isArray(child)) return child.map(render)
    if (typeof child !== 'string') return child
    // Stop at punctuation (including Chinese punctuation); leave sentence dots outside.
    const tokens = /(?:[a-z]:[\\/]|\/|\.{1,2}\/)?[\w@.-]+(?:[\\/][\w@.-]+)+(?:[:]\d+(?::\d+)?)?|[\w@.-]+\.[a-z][a-z0-9]{0,7}:\d+(?::\d+)?/gi
    const parts: ReactNode[] = []
    let offset = 0
    for (const match of child.matchAll(tokens)) {
      const path = match[0].replace(/[.,;:!?]+$/, '')
      if (!codePathTarget(path, workspace)) continue
      parts.push(child.slice(offset, match.index), <SmartLink key={match.index} href={path}>{path}</SmartLink>)
      offset = match.index + path.length
    }
    parts.push(child.slice(offset))
    return parts
  }
  return render(children)
}

interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
}

/**
 * Every newline in the text is a line break, the way it looked when typed.
 * For what people write in the message box, where a single Shift+Enter means
 * a new line; code blocks keep theirs anyway.
 */
function remarkLineBreaks() {
  const visit = (node: MdNode) => {
    if (!node.children) return
    node.children = node.children.flatMap((child): MdNode[] => {
      if (child.type !== 'text' || !child.value?.includes('\n')) {
        visit(child)
        return [child]
      }
      return child.value.split('\n').flatMap((part, index) => [
        ...(index ? [{ type: 'break' }] : []),
        ...(part ? [{ type: 'text', value: part }] : []),
      ])
    })
  }
  return visit
}

const PLUGINS = [remarkGfm]
const PLUGINS_WITH_BREAKS = [remarkGfm, remarkLineBreaks]

/** `breaks` keeps single newlines as line breaks; use it for what the user wrote. */
export const Markdown = memo(function Markdown({ text, breaks = false }: { text: string; breaks?: boolean }) {
  return (
    <div className="prose">
      <ReactMarkdown remarkPlugins={breaks ? PLUGINS_WITH_BREAKS : PLUGINS} components={components} urlTransform={urlTransform}>{text}</ReactMarkdown>
    </div>
  )
})
