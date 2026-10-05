import { Check, Copy } from 'lucide-react'
import { memo, useContext, type MouseEvent, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useCopy } from '../lib/hooks'
import { codePathTarget, LinkContext, linkTarget } from '../lib/links'

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node && typeof node === 'object' && 'props' in node) {
    return textOf((node.props as { children?: ReactNode }).children)
  }
  return ''
}

export function CodeBlock({ code, language }: { code: string; language?: string | undefined }) {
  const [copied, copy] = useCopy()
  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-block-lang">{language || 'text'}</span>
        <button type="button" className="code-copy" onClick={() => copy(code)} aria-label="Copy code">
          {copied ? <Check size={13} /> : <Copy size={13} />}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
        <pre><code>{language === 'javascript' || language === 'js' ? highlightJavaScript(code) : code}</code></pre>
    </div>
  )
}

function highlightJavaScript(code: string): ReactNode[] {
  const tokens = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\b(const|let|var|await|async|return|throw|try|catch|finally|if|else|for|of|while|function|new|true|false|null|undefined)\b|\b(0x[\da-fA-F]+|\d+(?:\.\d+)?)\b/g
  const output: ReactNode[] = []
  let offset = 0
  for (const match of code.matchAll(tokens)) {
    if (match.index > offset) output.push(code.slice(offset, match.index))
    const kind = match[1] ? 'comment' : match[2] ? 'string' : match[3] ? 'keyword' : 'number'
    output.push(<span key={match.index} className={`code-token-${kind}`}>{match[0]}</span>)
    offset = match.index + match[0].length
  }
  if (offset < code.length) output.push(code.slice(offset))
  return output
}

const components: Components = {
  pre({ children }) {
    const child = Array.isArray(children) ? children[0] : children
    const className = child && typeof child === 'object' && 'props' in child
      ? (child.props as { className?: string }).className
      : undefined
    const language = className?.match(/language-([\w+-]+)/)?.[1]
    return <CodeBlock code={textOf(children).replace(/\n$/, '')} language={language} />
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
  const { workspace, openPath, openLocalUrl } = useContext(LinkContext)
  const target = linkTarget(href, workspace)
  if (target.kind === 'file') {
    if (!openPath) return <span className="file-ref" title={target.path}>{children}</span>
    const open = (event: MouseEvent) => { event.preventDefault(); openPath(target.path) }
    return <a href={target.path} className="file-link" title={`Open ${target.path}${target.line ? ` (line ${target.line})` : ''}`} onClick={open}>{children}</a>
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
  const open = (event: MouseEvent) => { event.preventDefault(); openPath(target.path) }
  return <a href={target.path} className="file-link code-link" title={`Open ${target.path}`} onClick={open}><code>{children}</code></a>
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="prose">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={urlTransform}>{text}</ReactMarkdown>
    </div>
  )
})
