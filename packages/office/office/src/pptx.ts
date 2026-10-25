import type { Element } from '@xmldom/xmldom'
import pptxgen from 'pptxgenjs'
import { OfficeError } from './errors.js'
import { assertColor, assertTheme, palette, tint, type Theme } from './theme.js'
import { assertChart, isRound, parseChartXml, type ChartRead, type ChartSpec, type ChartType } from './chart.js'
import { attribute, child, children, descendants, openPackage, readXml, relationshipId, relationships, requireXml } from './ooxml.js'

// pptxgenjs 的类型按 ESM 写成，包本身却是 CommonJS：NodeNext 下 TS 认为类在 `.default` 上，
// 而运行时 ESM 构建直接导出类。两种形状都接受。
const PptxGenJS = 'default' in pptxgen ? pptxgen.default : pptxgen
type Slide = ReturnType<InstanceType<typeof PptxGenJS>['addSlide']>

export interface SlideSpec {
  title?: string
  /** 只有标题与副标题的幻灯片按封面排版。 */
  subtitle?: string
  text?: string
  bullets?: string[]
  table?: { rows: string[][], header?: boolean }
  /** 原生 PowerPoint 图表，数据内嵌。 */
  chart?: ChartSpec
  notes?: string
}

export interface PresentationSpec {
  title?: string
  layout?: '16x9' | '4x3'
  /** 字体用于所有文字（标题可单独指定）；强调色用于标题、表头与图表。 */
  theme?: Theme
  /** 每页背景色，6 位十六进制 RGB。 */
  background?: string
  /** 在右下角显示页码。 */
  slideNumbers?: boolean
  slides: SlideSpec[]
}

export interface SlideShape {
  name: string
  /** 占位符类型，例如 `title`、`body`；普通文本框没有。 */
  placeholder?: string
  text: string
}

export interface SlideOutput {
  /** 1 起始，与 PowerPoint 中的页码一致。 */
  index: number
  title?: string
  shapes: SlideShape[]
  tables: string[][][]
  charts: ChartRead[]
  notes?: string
}

export interface PresentationOutline {
  slides: number
  /** 幻灯片尺寸（英寸）。 */
  size?: { width: number, height: number }
  titles: { index: number, title: string | null }[]
}

export interface ReadPresentationRequest {
  /** 从第几页开始（1 起）。 */
  start?: number
  count?: number
}

export interface PresentationRead {
  slides: SlideOutput[]
  total: number
  truncated: boolean
}

export const DEFAULT_SLIDE_LIMIT = 20

const LAYOUTS = {
  '16x9': { name: 'LAYOUT_16x9', width: 10, height: 5.625 },
  '4x3': { name: 'LAYOUT_4x3', width: 10, height: 7.5 },
} as const

const MARGIN = 0.5
const TITLE_HEIGHT = 0.9

/** 一份演示文稿内所有幻灯片共享的外观与尺寸。 */
interface DeckLook {
  width: number
  height: number
  theme: Theme | undefined
  background: string | undefined
  slideNumbers: boolean
}

function textFace(look: DeckLook, heading = false): { fontFace?: string } {
  const face = heading ? look.theme?.headingFont ?? look.theme?.font : look.theme?.font
  return face ? { fontFace: face } : {}
}

function addBody(slide: Slide, spec: SlideSpec, look: DeckLook, top: number, bottom: number): void {
  const width = look.width - 2 * MARGIN
  const body = textFace(look)
  const parts: ((y: number, h: number) => void)[] = []
  if (spec.text) {
    const text = spec.text
    parts.push((y, h) => slide.addText(text, { objectName: 'Body', x: MARGIN, y, w: width, h, fontSize: 18, valign: 'top', ...body }))
  }
  if (spec.bullets?.length) {
    const items = spec.bullets.map(item => ({ text: item, options: { bullet: true, breakLine: true } }))
    parts.push((y, h) => slide.addText(items, { objectName: 'Bullets', x: MARGIN, y, w: width, h, fontSize: 18, valign: 'top', ...body }))
  }
  if (spec.table) {
    const { rows, header } = spec.table
    const columns = Math.max(0, ...rows.map(row => row.length))
    if (columns === 0) throw new OfficeError('a slide table needs at least one cell', 'OFFICE_INVALID')
    const headerFill = look.theme?.accent ? tint(look.theme.accent) : 'F2F2F2'
    const tableRows = rows.map((row, r) => Array.from({ length: columns }, (_, c) => ({
      text: row[c] ?? '',
      options: header && r === 0 ? { bold: true, fill: { color: headerFill } } : {},
    })))
    parts.push((y, h) => slide.addTable(tableRows, { objectName: 'Table', x: MARGIN, y, w: width, h, fontSize: 14, border: { type: 'solid', pt: 0.5, color: 'BFBFBF' }, ...body }))
  }
  if (spec.chart) {
    const chart = spec.chart
    assertChart(chart)
    parts.push((y, h) => addChart(slide, chart, look, { x: MARGIN, y, w: width, h }))
  }
  const height = (bottom - top) / Math.max(1, parts.length)
  parts.forEach((place, index) => place(top + index * height, height))
}

const PPTX_CHART: Record<ChartType, 'bar' | 'line' | 'area' | 'pie' | 'doughnut'> = {
  column: 'bar', bar: 'bar', line: 'line', area: 'area', pie: 'pie', doughnut: 'doughnut',
}

function addChart(slide: Slide, chart: ChartSpec, look: DeckLook, box: { x: number, y: number, w: number, h: number }): void {
  const round = isRound(chart.type)
  const scheme = palette(look.theme)
  const colors = round ? scheme : chart.series.map((series, index) => series.color ?? scheme[index % scheme.length] ?? '4472C4')
  slide.addChart(PPTX_CHART[chart.type], chart.series.map(series => ({
    name: series.name,
    labels: chart.categories,
    // pptxgenjs 不接受 null；留空的点按 0 画出。
    values: chart.categories.map((_, index) => series.values[index] ?? 0),
  })), {
    ...box,
    objectName: 'Chart',
    chartColors: colors,
    showLegend: chart.legend !== false,
    legendPos: 'b',
    ...(chart.title ? { showTitle: true, title: chart.title } : {}),
    ...(chart.type === 'bar' ? { barDir: 'bar' } : chart.type === 'column' ? { barDir: 'col' } : {}),
    ...(chart.stacked && chart.type !== 'line' && !round ? { barGrouping: 'stacked' } : {}),
    ...(chart.dataLabels ? (round ? { showPercent: true } : { showValue: true }) : {}),
    ...(chart.type === 'doughnut' ? { holeSize: 50 } : {}),
    ...(look.theme?.font ? { titleFontFace: look.theme.headingFont ?? look.theme.font, legendFontFace: look.theme.font, catAxisLabelFontFace: look.theme.font, valAxisLabelFontFace: look.theme.font } : {}),
  })
}

function addSlide(pptx: InstanceType<typeof PptxGenJS>, spec: SlideSpec, look: DeckLook): void {
  const slide = pptx.addSlide()
  const width = look.width - 2 * MARGIN
  const titleColor = look.theme?.accent ? { color: look.theme.accent } : {}
  if (look.background) slide.background = { color: look.background }
  if (look.slideNumbers) slide.slideNumber = { x: look.width - 0.9, y: look.height - 0.45, w: 0.6, h: 0.3, fontSize: 10, color: '8C8C8C', align: 'right' }
  const cover = spec.subtitle !== undefined && !spec.text && !spec.bullets?.length && !spec.table && !spec.chart
  if (cover) {
    const middle = look.height / 2
    slide.addText(spec.title ?? '', { objectName: 'Title', x: MARGIN, y: middle - 1.1, w: width, h: 1.2, fontSize: 36, bold: true, align: 'center', ...titleColor, ...textFace(look, true) })
    slide.addText(spec.subtitle ?? '', { objectName: 'Subtitle', x: MARGIN, y: middle + 0.2, w: width, h: 0.8, fontSize: 20, align: 'center', color: '595959', ...textFace(look) })
  } else {
    if (spec.title) {
      slide.addText(spec.title, { objectName: 'Title', x: MARGIN, y: 0.3, w: width, h: TITLE_HEIGHT, fontSize: 28, bold: true, ...titleColor, ...textFace(look, true) })
    }
    const top = spec.title ? 0.3 + TITLE_HEIGHT + 0.1 : MARGIN
    addBody(slide, spec, look, top, look.height - MARGIN)
  }
  if (spec.notes) slide.addNotes(spec.notes)
}

export interface DeckOptions extends Omit<PresentationSpec, 'slides'> {
  /** 自定义幻灯片尺寸（英寸），优先于 `layout`；向已有文稿追加页时用它对齐原尺寸。 */
  size?: { width: number, height: number }
}

/** 用 pptxgenjs 按规格生成一份完整的演示文稿。 */
export async function buildDeck(slides: readonly SlideSpec[], options: DeckOptions): Promise<Uint8Array> {
  const preset = LAYOUTS[options.layout ?? '16x9']
  if (!preset) throw new OfficeError(`unknown layout: ${options.layout}`, 'OFFICE_INVALID')
  assertTheme(options.theme)
  assertColor(options.background, 'background')
  const pptx = new PptxGenJS()
  const layout = options.size ? { name: 'TNEGA_CUSTOM', ...options.size } : preset
  if (options.size) pptx.defineLayout({ name: layout.name, width: layout.width, height: layout.height })
  pptx.layout = layout.name
  if (options.title) pptx.title = options.title
  const look: DeckLook = {
    width: layout.width,
    height: layout.height,
    theme: options.theme,
    background: options.background,
    slideNumbers: Boolean(options.slideNumbers),
  }
  for (const slideSpec of slides) addSlide(pptx, slideSpec, look)
  const output = await pptx.write({ outputType: 'uint8array' })
  if (!(output instanceof Uint8Array)) throw new OfficeError('pptxgenjs did not produce bytes', 'OFFICE_UNSUPPORTED')
  return output
}

export async function createPresentation(spec: PresentationSpec): Promise<Uint8Array> {
  if (!spec.slides?.length) throw new OfficeError('a presentation needs at least one slide', 'OFFICE_INVALID')
  const { slides, ...options } = spec
  return buildDeck(slides, options)
}

/** DrawingML 段落文本：`a:t` 拼接，`a:br` 为换行；段落之间用换行分隔。 */
function drawingText(container: Element): string {
  return descendants(container, 'p')
    .filter(paragraph => paragraph.namespaceURI?.includes('drawingml'))
    .map(paragraph => {
      let text = ''
      const walk = (element: Element): void => {
        for (const node of children(element)) {
          if (node.localName === 't') text += node.textContent ?? ''
          else if (node.localName === 'br') text += '\n'
          else walk(node)
        }
      }
      walk(paragraph)
      return text
    })
    .join('\n')
}

const EMU_PER_INCH = 914_400

interface ParsedPresentation {
  slides: string[]
  size?: { width: number, height: number }
  zip: Awaited<ReturnType<typeof openPackage>>
}

async function parsePresentation(bytes: Uint8Array): Promise<ParsedPresentation> {
  const zip = await openPackage(bytes, 'pptx')
  const presentation = await requireXml(zip, 'ppt/presentation.xml', 'pptx')
  const rels = await relationships(zip, 'ppt/_rels/presentation.xml.rels', 'ppt')
  const slides = descendants(presentation, 'sldId').flatMap(slide => {
    const target = rels.get(relationshipId(slide) ?? '')
    return target ? [target] : []
  })
  const size = descendants(presentation, 'sldSz')[0]
  const cx = Number(attribute(size, 'cx'))
  const cy = Number(attribute(size, 'cy'))
  return {
    zip,
    slides,
    ...(cx > 0 && cy > 0 ? { size: { width: Math.round((cx / EMU_PER_INCH) * 100) / 100, height: Math.round((cy / EMU_PER_INCH) * 100) / 100 } } : {}),
  }
}

async function readSlide(parsed: ParsedPresentation, index: number): Promise<SlideOutput> {
  const path = parsed.slides[index - 1] ?? ''
  const document = await requireXml(parsed.zip, path, 'pptx')
  const shapes: SlideShape[] = descendants(document, 'sp').map(shape => {
    const properties = child(shape, 'nvSpPr') ?? shape
    const ph = descendants(properties, 'ph')[0]
    // 没有 type 的占位符按规范是正文（body）。
    const placeholder = ph ? attribute(ph, 'type') ?? 'body' : undefined
    return {
      name: attribute(descendants(properties, 'cNvPr')[0], 'name') ?? '',
      ...(placeholder ? { placeholder } : {}),
      text: drawingText(shape),
    }
  })
  const tables = descendants(document, 'tbl').map(table =>
    children(table, 'tr').map(row => children(row, 'tc').map(drawingText)))
  const title = shapes.find(shape => shape.placeholder === 'title' || shape.placeholder === 'ctrTitle')
    ?? shapes.find(shape => shape.name === 'Title')

  const directory = path.slice(0, path.lastIndexOf('/'))
  const file = path.slice(path.lastIndexOf('/') + 1)
  const slideRels = await relationships(parsed.zip, `${directory}/_rels/${file}.rels`, directory)
  const charts: ChartRead[] = []
  for (const reference of descendants(document, 'chart')) {
    const chartPath = slideRels.get(relationshipId(reference) ?? '')
    const chartXml = chartPath ? await readXml(parsed.zip, chartPath) : undefined
    if (chartXml) charts.push(parseChartXml(chartXml))
  }
  const notesPath = [...slideRels.values()].find(target => /notesSlide\d*\.xml$/.test(target))
  const notesDocument = notesPath ? await readXml(parsed.zip, notesPath) : undefined
  const notes = notesDocument
    ? descendants(notesDocument, 'sp')
      .filter(shape => attribute(descendants(shape, 'ph')[0], 'type') === 'body')
      .map(drawingText)
      .join('\n')
    : ''

  return {
    index,
    ...(title?.text ? { title: title.text } : {}),
    shapes: shapes.filter(shape => shape.text !== ''),
    tables,
    charts,
    ...(notes ? { notes } : {}),
  }
}

export async function inspectPresentation(bytes: Uint8Array): Promise<PresentationOutline> {
  const parsed = await parsePresentation(bytes)
  const titles: PresentationOutline['titles'] = []
  for (let index = 1; index <= parsed.slides.length; index++) {
    titles.push({ index, title: (await readSlide(parsed, index)).title ?? null })
  }
  return { slides: parsed.slides.length, ...(parsed.size ? { size: parsed.size } : {}), titles }
}

export async function readPresentation(bytes: Uint8Array, request: ReadPresentationRequest = {}): Promise<PresentationRead> {
  const parsed = await parsePresentation(bytes)
  const total = parsed.slides.length
  const start = Math.max(1, request.start ?? 1)
  const end = Math.min(total, start + Math.max(1, request.count ?? DEFAULT_SLIDE_LIMIT) - 1)
  const slides: SlideOutput[] = []
  for (let index = start; index <= end; index++) slides.push(await readSlide(parsed, index))
  return { slides, total, truncated: end < total }
}
