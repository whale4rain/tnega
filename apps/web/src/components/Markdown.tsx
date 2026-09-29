import { Check, Copy } from 'lucide-react'
import { memo, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useCopy } from '../lib/hooks'

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
      <pre><code>{code}</code></pre>
    </div>
  )
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
    return <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>
  },
  table({ children }) {
    return <div className="table-scroll"><table>{children}</table></div>
  },
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="prose">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown>
    </div>
  )
})
