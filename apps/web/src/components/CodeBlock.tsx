import { Check, Copy } from 'lucide-react'
import type { ReactNode } from 'react'
import { useCopy } from '../lib/hooks'

/**
 * A code block is one sunken shape (Umbrella conversation.md): no border and no header bar. The language
 * is a quiet label at the top right; a round copy button appears left of it on hover or keyboard focus.
 */
export function CodeBlock({ code, language }: { code: string; language?: string | undefined }) {
  const [copied, copy] = useCopy()
  return (
    <div className="code-block">
      <div className="code-block-tools">
        <button type="button" className="code-copy" onClick={() => copy(code)} aria-label={copied ? 'Copied' : 'Copy code'} title={copied ? 'Copied' : 'Copy code'}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
        <span className="code-block-lang">{language || 'text'}</span>
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
