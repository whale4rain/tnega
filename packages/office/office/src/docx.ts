import type { Element } from '@xmldom/xmldom'
import {
  AlignmentType,
  Document,
  Footer,
  Header,
  HeadingLevel,
  LevelFormat,
  Packer,
  PageBreak,
  PageNumber,
  PageOrientation,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx'
import { ChartRun } from 'docx/charts'
import { OfficeError } from './errors.js'
import { assertTheme, palette, tint, type Theme } from './theme.js'
import { attribute, child, children, descendants, openPackage, readXml, relationshipId, relationships, requireXml } from './ooxml.js'
import { assertChart, parseChartXml, type ChartRead, type ChartSpec } from './chart.js'

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
  /** 原生 Word 图表，数据内嵌，可在 Word 中“编辑数据”。尺寸以像素计，缺省 600×360。 */
  | { type: 'chart', chart: ChartSpec, width?: number, height?: number }

export interface PageSetup {
  size?: 'A4' | 'Letter'
  orientation?: 'portrait' | 'landscape'
  /** 四边页边距（厘米）。 */
  margin?: number
}

export interface DocumentSpec {
  title?: string
  /** 正文与标题字体；强调色用于标题与表头。 */
  theme?: Theme
  page?: PageSetup
  /** 每页页眉文字。 */
  header?: string
  /** 每页页脚文字。 */
  footer?: string
  /** 在页脚显示“第 X 页 / 共 Y 页”。 */
  pageNumbers?: boolean
  blocks: DocBlock[]
}

export type DocBlockOutput =
  | { index: number, type: 'paragraph', style?: string, text: string }
  | { index: number, type: 'table', rows: string[][] }
  | { index: number, type: 'chart', chart: ChartRead }

export interface DocumentRead {
  blocks: DocBlockOutput[]
  total: number
  truncated: boolean
}

export interface DocumentOutline {
  paragraphs: number
  tables: number
  charts: number
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

function blockChildren(block: DocBlock, theme: Theme | undefined): (Paragraph | Table)[] {
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
            ...(block.header && r === 0 && theme?.accent
              ? { shading: { fill: tint(theme.accent), type: ShadingType.CLEAR, color: 'auto' } }
              : {}),
          })),
        })),
      })]
    }
    case 'pageBreak':
      return [new Paragraph({ children: [new PageBreak()] })]
    case 'chart':
      return [new Paragraph({ alignment: AlignmentType.CENTER, children: [chartRun(block, theme)] })]
    default: {
      const unknown: never = block
      throw new OfficeError(`unknown document block: ${JSON.stringify(unknown)}`, 'OFFICE_INVALID')
    }
  }
}

function chartRun(block: Extract<DocBlock, { type: 'chart' }>, theme: Theme | undefined): ChartRun {
  const spec = block.chart
  assertChart(spec)
  const colors = palette(theme)
  const common = {
    ...(spec.title ? { title: spec.title } : {}),
    ...(spec.legend === false ? { legend: false as const } : {}),
    transformation: { width: block.width ?? 600, height: block.height ?? 360 },
  }
  if (spec.type === 'pie' || spec.type === 'doughnut') {
    return new ChartRun({
      ...common,
      type: spec.type,
      categories: spec.categories,
      series: spec.series.map(series => ({
        name: series.name,
        values: series.values,
        colors: spec.categories.map((_, index) => colors[index % colors.length]),
      })),
      ...(spec.dataLabels ? { dataLabels: { percentage: true } } : {}),
    })
  }
  return new ChartRun({
    ...common,
    type: spec.type,
    categories: spec.categories,
    series: spec.series.map((series, index) => ({
      name: series.name,
      values: series.values,
      color: series.color ?? colors[index % colors.length] ?? '4472C4',
    })),
    ...(spec.stacked && spec.type !== 'line' ? { stacking: 'stacked' as const } : {}),
    ...(spec.dataLabels ? { dataLabels: { value: true } } : {}),
  })
}

/** twips：Word 的长度单位，1 厘米约 567。 */
const TWIPS_PER_CM = 567
const PAGE_SIZES = { A4: { width: 11906, height: 16838 }, Letter: { width: 12240, height: 15840 } } as const

function headingStyles(theme: Theme | undefined) {
  const font = theme?.headingFont ?? theme?.font
  if (!font && !theme?.accent) return {}
  const run = { ...(font ? { font } : {}), ...(theme?.accent ? { color: theme.accent } : {}) }
  return {
    title: { run }, heading1: { run }, heading2: { run }, heading3: { run },
    heading4: { run }, heading5: { run }, heading6: { run },
  }
}

function sectionProperties(page: PageSetup | undefined) {
  if (!page) return {}
  const size = PAGE_SIZES[page.size ?? 'A4']
  if (!size) throw new OfficeError(`page.size must be A4 or Letter: ${page.size}`, 'OFFICE_INVALID')
  if (page.margin !== undefined && !(page.margin >= 0 && page.margin <= 10)) {
    throw new OfficeError(`page.margin must be between 0 and 10 cm: ${page.margin}`, 'OFFICE_INVALID')
  }
  const margin = page.margin === undefined ? undefined : Math.round(page.margin * TWIPS_PER_CM)
  return {
    properties: {
      page: {
        size: {
          ...size,
          orientation: page.orientation === 'landscape' ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT,
        },
        ...(margin !== undefined ? { margin: { top: margin, right: margin, bottom: margin, left: margin } } : {}),
      },
    },
  }
}

function headerFooter(spec: DocumentSpec) {
  const footerRuns: TextRun[] = []
  if (spec.footer) footerRuns.push(new TextRun(spec.footer))
  if (spec.pageNumbers) {
    if (spec.footer) footerRuns.push(new TextRun('   ·   '))
    footerRuns.push(new TextRun({ children: ['Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES] }))
  }
  return {
    ...(spec.header ? { headers: { default: new Header({ children: [new Paragraph({ children: [new TextRun(spec.header)], alignment: AlignmentType.RIGHT })] }) } } : {}),
    ...(footerRuns.length ? { footers: { default: new Footer({ children: [new Paragraph({ children: footerRuns, alignment: AlignmentType.CENTER })] }) } } : {}),
  }
}

export async function createDocument(spec: DocumentSpec): Promise<Uint8Array> {
  if (!Array.isArray(spec.blocks)) throw new OfficeError('a document needs a blocks array', 'OFFICE_INVALID')
  assertTheme(spec.theme)
  const document = new Document({
    ...(spec.title ? { title: spec.title } : {}),
    styles: {
      default: {
        ...(spec.theme?.font ? { document: { run: { font: spec.theme.font } } } : {}),
        ...headingStyles(spec.theme),
      },
    },
    numbering: {
      config: [{
        reference: ORDERED,
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.START }],
      }],
    },
    sections: [{
      ...sectionProperties(spec.page),
      ...headerFooter(spec),
      children: spec.blocks.flatMap(block => blockChildren(block, spec.theme)),
    }],
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

  const rels = await relationships(zip, 'word/_rels/document.xml.rels', 'word')
  const blocks: DocBlockOutput[] = []
  for (const element of children(body)) {
    const chartRef = element.localName === 'p' ? descendants(element, 'chart').find(node => relationshipId(node)) : undefined
    const chartPath = chartRef ? rels.get(relationshipId(chartRef) ?? '') : undefined
    const chartXml = chartPath ? await readXml(zip, chartPath) : undefined
    if (chartXml) {
      blocks.push({ index: blocks.length, type: 'chart', chart: parseChartXml(chartXml) })
    } else if (element.localName === 'p') {
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
  const outline: DocumentOutline = { paragraphs: 0, tables: 0, charts: 0, words: 0, headings: [] }
  const countWords = (text: string): number => text.split(/\s+/).filter(Boolean).length
  for (const block of blocks) {
    if (block.type === 'chart') {
      outline.charts++
      continue
    }
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
