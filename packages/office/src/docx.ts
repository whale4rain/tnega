import type { Element } from '@xmldom/xmldom'
import {
  AlignmentType,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  PageBreak,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx'
import { OfficeError } from './errors.js'
import { attribute, child, children, descendants, openPackage, readXml, requireXml } from './ooxml.js'

export interface TextSpan {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
}

/** 段落内容：纯文本，或带行内格式的片段。 */
export type Inline = string | TextSpan[]

export type DocBlock =
  | { type: 'heading', level: 1 | 2 | 3 | 4 | 5 | 6, text: string }
  | { type: 'paragraph', text: Inline, align?: 'left' | 'center' | 'right' | 'justify' }
  | { type: 'list', items: Inline[], ordered?: boolean }
  | { type: 'table', rows: string[][], header?: boolean }
  | { type: 'pageBreak' }

export interface DocumentSpec {
  title?: string
  blocks: DocBlock[]
}

export type DocBlockOutput =
  | { index: number, type: 'paragraph', style?: string, text: string }
  | { index: number, type: 'table', rows: string[][] }

export interface DocumentRead {
  blocks: DocBlockOutput[]
  total: number
  truncated: boolean
}

export interface DocumentOutline {
  paragraphs: number
  tables: number
  words: number
  headings: { index: number, level: number, text: string }[]
}

export interface ReadDocumentRequest {
  /** 从第几个块开始（段落与表格统一编号，0 起）。 */
  offset?: number
  limit?: number
}

export const DEFAULT_BLOCK_LIMIT = 200

const HEADINGS = [
  HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6,
] as const

const ALIGNMENTS = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED,
} as const

const ORDERED = 'tnega-ordered'

function runs(inline: Inline): TextRun[] {
  if (typeof inline === 'string') return [new TextRun(inline)]
  return inline.map(span => new TextRun({
    text: span.text,
    ...(span.bold !== undefined ? { bold: span.bold } : {}),
    ...(span.italic !== undefined ? { italic: span.italic } : {}),
    ...(span.underline ? { underline: {} } : {}),
  }))
}

function blockChildren(block: DocBlock): (Paragraph | Table)[] {
  switch (block.type) {
    case 'heading': {
      const heading = HEADINGS[block.level - 1]
      if (!heading) throw new OfficeError(`heading level must be 1-6: ${block.level}`, 'OFFICE_INVALID')
      return [new Paragraph({ text: block.text, heading })]
    }
    case 'paragraph':
      return [new Paragraph({
        children: runs(block.text),
        ...(block.align ? { alignment: ALIGNMENTS[block.align] } : {}),
      })]
    case 'list':
      return block.items.map(item => new Paragraph({
        children: runs(item),
        ...(block.ordered ? { numbering: { reference: ORDERED, level: 0 } } : { bullet: { level: 0 } }),
      }))
    case 'table': {
      const width = Math.max(0, ...block.rows.map(row => row.length))
      if (width === 0) throw new OfficeError('a table needs at least one cell', 'OFFICE_INVALID')
      return [new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: block.rows.map((row, r) => new TableRow({
          tableHeader: Boolean(block.header) && r === 0,
          children: Array.from({ length: width }, (_, c) => new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: row[c] ?? '', bold: Boolean(block.header) && r === 0 })] })],
          })),
        })),
      })]
    }
    case 'pageBreak':
      return [new Paragraph({ children: [new PageBreak()] })]
    default: {
      const unknown: never = block
      throw new OfficeError(`unknown document block: ${JSON.stringify(unknown)}`, 'OFFICE_INVALID')
    }
  }
}

export async function createDocument(spec: DocumentSpec): Promise<Uint8Array> {
  if (!Array.isArray(spec.blocks)) throw new OfficeError('a document needs a blocks array', 'OFFICE_INVALID')
  const document = new Document({
    ...(spec.title ? { title: spec.title } : {}),
    numbering: {
      config: [{
        reference: ORDERED,
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.START }],
      }],
    },
    sections: [{ children: spec.blocks.flatMap(blockChildren) }],
  })
  return new Uint8Array(await Packer.toBuffer(document))
}

/** 段落文本：按文档序拼接 `w:t`，`w:tab` 与换行保留为空白。 */
function paragraphText(paragraph: Element): string {
  let text = ''
  const walk = (element: Element): void => {
    for (const node of children(element)) {
      if (node.localName === 't') text += node.textContent ?? ''
      else if (node.localName === 'tab') text += '\t'
      // 分页、分栏不是文本；只有普通换行保留为 `\n`。
      else if (node.localName === 'cr' || (node.localName === 'br' && !attribute(node, 'type'))) text += '\n'
      else walk(node)
    }
  }
  walk(paragraph)
  return text
}

interface ParsedDocument {
  blocks: DocBlockOutput[]
  /** styleId → 样式显示名（例如 `Heading1` → `heading 1`）。 */
  styleNames: Map<string, string>
}

async function parseDocument(bytes: Uint8Array): Promise<ParsedDocument> {
  const zip = await openPackage(bytes, 'docx')
  const document = await requireXml(zip, 'word/document.xml', 'docx')
  const body = descendants(document, 'body')[0]
  if (!body) throw new OfficeError('not a docx file: missing document body', 'OFFICE_INVALID')

  const styleNames = new Map<string, string>()
  const styles = await readXml(zip, 'word/styles.xml')
  for (const style of styles ? descendants(styles, 'style') : []) {
    const id = attribute(style, 'styleId')
    const name = attribute(child(style, 'name'), 'val')
    if (id && name) styleNames.set(id, name)
  }

  const blocks: DocBlockOutput[] = []
  for (const element of children(body)) {
    if (element.localName === 'p') {
      const style = attribute(child(child(element, 'pPr') ?? element, 'pStyle'), 'val')
      blocks.push({ index: blocks.length, type: 'paragraph', ...(style ? { style } : {}), text: paragraphText(element) })
    } else if (element.localName === 'tbl') {
      blocks.push({
        index: blocks.length,
        type: 'table',
        rows: children(element, 'tr').map(row => children(row, 'tc').map(cell => children(cell, 'p').map(paragraphText).join('\n'))),
      })
    }
  }
  return { blocks, styleNames }
}

function headingLevel(style: string | undefined, styleNames: Map<string, string>): number | undefined {
  if (!style) return undefined
  const name = (styleNames.get(style) ?? style).toLowerCase().replace(/\s+/g, '')
  if (name === 'title') return 0
  const match = /^heading(\d)$/.exec(name)
  return match ? Number(match[1]) : undefined
}

export async function inspectDocument(bytes: Uint8Array): Promise<DocumentOutline> {
  const { blocks, styleNames } = await parseDocument(bytes)
  const outline: DocumentOutline = { paragraphs: 0, tables: 0, words: 0, headings: [] }
  const countWords = (text: string): number => text.split(/\s+/).filter(Boolean).length
  for (const block of blocks) {
    if (block.type === 'table') {
      outline.tables++
      outline.words += block.rows.flat().reduce((sum, cell) => sum + countWords(cell), 0)
      continue
    }
    outline.paragraphs++
    outline.words += countWords(block.text)
    const level = headingLevel(block.style, styleNames)
    if (level !== undefined) outline.headings.push({ index: block.index, level, text: block.text })
  }
  return outline
}

export async function readDocument(bytes: Uint8Array, request: ReadDocumentRequest = {}): Promise<DocumentRead> {
  const { blocks } = await parseDocument(bytes)
  const offset = Math.max(0, request.offset ?? 0)
  const limit = Math.max(1, request.limit ?? DEFAULT_BLOCK_LIMIT)
  const slice = blocks.slice(offset, offset + limit)
  return { blocks: slice, total: blocks.length, truncated: offset + slice.length < blocks.length }
}
