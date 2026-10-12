/**
 * Markdown as Ink elements. `marked` only tokenises; layout and wrapping
 * stay with Ink, which measures CJK text by cell width. The styling is quiet
 * on purpose: weight and dimness carry structure, never colour.
 */
import { Box, Text } from 'ink'
import { Lexer, type Token, type Tokens } from 'marked'
import type { ReactNode } from 'react'
import { padEnd, stringWidth } from './width.js'

export function Markdown({ text, width }: { text: string; width: number }) {
  const tokens = Lexer.lex(text, { gfm: true })
  return <Box flexDirection="column">{blocks(tokens, width)}</Box>
}

function blocks(tokens: readonly Token[], width: number): ReactNode[] {
  const out: ReactNode[] = []
  let gap = false
  tokens.forEach((token, index) => {
    if (token.type === 'space') return
    const node = block(token, width, index)
    if (node === null) return
    out.push(gap ? <Box key={`b${index}`} marginTop={1} flexDirection="column">{node}</Box> : <Box key={`b${index}`} flexDirection="column">{node}</Box>)
    gap = true
  })
  return out
}

function block(token: Token, width: number, key: number): ReactNode {
  switch (token.type) {
    case 'heading': {
      const heading = token as Tokens.Heading
      return <Text bold underline={heading.depth === 1}>{inline(heading.tokens)}</Text>
    }
    case 'paragraph':
      return <Text>{inline((token as Tokens.Paragraph).tokens)}</Text>
    case 'text': {
      const text = token as Tokens.Text
      return <Text>{text.tokens ? inline(text.tokens) : text.text}</Text>
    }
    case 'code': {
      const code = token as Tokens.Code
      return (
        <Box flexDirection="column" borderStyle="single" borderTop={false} borderRight={false} borderBottom={false} borderDimColor paddingLeft={1}>
          {code.lang ? <Text dimColor>{code.lang}</Text> : null}
          <Text>{code.text}</Text>
        </Box>
      )
    }
    case 'blockquote':
      return (
        <Box flexDirection="column" borderStyle="single" borderTop={false} borderRight={false} borderBottom={false} borderDimColor paddingLeft={1}>
          <Text dimColor>{plain((token as Tokens.Blockquote).tokens)}</Text>
        </Box>
      )
    case 'list':
      return <List list={token as Tokens.List} width={width} />
    case 'hr':
      return <Text dimColor>{'─'.repeat(Math.max(3, Math.min(width, 40)))}</Text>
    case 'table':
      return <Table table={token as Tokens.Table} width={width} />
    case 'html':
      return <Text dimColor>{(token as Tokens.HTML).text.trimEnd()}</Text>
    default:
      return 'raw' in token && typeof token.raw === 'string' && token.raw.trim() ? <Text key={key}>{token.raw.trimEnd()}</Text> : null
  }
}

function List({ list, width }: { list: Tokens.List; width: number }) {
  const start = typeof list.start === 'number' ? list.start : 1
  return (
    <Box flexDirection="column">
      {list.items.map((item, index) => {
        const marker = item.task ? (item.checked ? '[x]' : '[ ]') : list.ordered ? `${start + index}.` : '•'
        return (
          <Box key={index} flexDirection="row">
            <Box width={stringWidth(marker) + 1} flexShrink={0}><Text dimColor>{marker}</Text></Box>
            <Box flexDirection="column" flexGrow={1}>{listItem(item, width - stringWidth(marker) - 1)}</Box>
          </Box>
        )
      })}
    </Box>
  )
}

function listItem(item: Tokens.ListItem, width: number): ReactNode[] {
  // Tight list items hold bare `text` tokens; loose ones hold paragraphs.
  return item.tokens.flatMap((token, index) => {
    if (token.type === 'space') return []
    if (token.type === 'list') return [<List key={index} list={token as Tokens.List} width={width} />]
    return [<Box key={index} flexDirection="column">{block(token, width, index)}</Box>]
  })
}

function Table({ table, width }: { table: Tokens.Table; width: number }) {
  const header = table.header.map(cell => plain(cell.tokens))
  const rows = table.rows.map(row => row.map(cell => plain(cell.tokens)))
  const columns = header.map((cell, index) => Math.max(stringWidth(cell), ...rows.map(row => stringWidth(row[index] ?? ''))))
  const total = columns.reduce((sum, column) => sum + column, 0) + (columns.length - 1) * 3
  if (total > width) {
    // Too wide to align: one record per line, which still wraps cleanly.
    return (
      <Box flexDirection="column">
        {rows.map((row, index) => (
          <Text key={index}>{row.map((cell, column) => `${header[column] ?? ''}: ${cell}`).join(' · ')}</Text>
        ))}
      </Box>
    )
  }
  const line = (cells: readonly string[]) => cells.map((cell, index) => padEnd(cell, columns[index] ?? 0)).join('   ').trimEnd()
  return (
    <Box flexDirection="column">
      <Text bold>{line(header)}</Text>
      <Text dimColor>{columns.map(column => '─'.repeat(column)).join('   ')}</Text>
      {rows.map((row, index) => <Text key={index}>{line(row)}</Text>)}
    </Box>
  )
}

function inline(tokens: readonly Token[] | undefined): ReactNode[] {
  if (!tokens) return []
  return tokens.map((token, index) => {
    switch (token.type) {
      case 'strong':
        return <Text key={index} bold>{inline((token as Tokens.Strong).tokens)}</Text>
      case 'em':
        return <Text key={index} italic>{inline((token as Tokens.Em).tokens)}</Text>
      case 'del':
        return <Text key={index} strikethrough>{inline((token as Tokens.Del).tokens)}</Text>
      case 'codespan':
        return <Text key={index} bold>{unescape((token as Tokens.Codespan).text)}</Text>
      case 'link': {
        const link = token as Tokens.Link
        const label = plain(link.tokens)
        return label && label !== link.href
          ? <Text key={index}><Text underline>{inline(link.tokens)}</Text><Text dimColor> ({link.href})</Text></Text>
          : <Text key={index} underline>{link.href}</Text>
      }
      case 'image': {
        const image = token as Tokens.Image
        return <Text key={index} dimColor>[image: {image.text || image.href}]</Text>
      }
      case 'br':
        return '\n'
      case 'text': {
        const text = token as Tokens.Text
        return text.tokens ? <Text key={index}>{inline(text.tokens)}</Text> : unescape(text.text)
      }
      case 'escape':
        return (token as Tokens.Escape).text
      case 'html':
        return (token as Tokens.HTML).text
      default:
        return 'raw' in token && typeof token.raw === 'string' ? token.raw : ''
    }
  })
}

/** Text content of inline tokens without styling, for tables and quotes. */
export function plain(tokens: readonly Token[] | undefined): string {
  if (!tokens) return ''
  return tokens.map(token => {
    if ('tokens' in token && Array.isArray(token.tokens) && token.type !== 'codespan') return plain(token.tokens)
    if (token.type === 'paragraph' || token.type === 'text' || token.type === 'codespan' || token.type === 'escape') return unescape((token as Tokens.Text).text)
    if (token.type === 'br' || token.type === 'space') return '\n'
    return 'raw' in token && typeof token.raw === 'string' ? token.raw : ''
  }).join('')
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }

function unescape(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, entity => ENTITIES[entity] ?? entity)
}
