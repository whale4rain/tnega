import { DOMParser, XMLSerializer, type Document, type Element } from '@xmldom/xmldom'
import type JSZip from 'jszip'
import { columnName, formatAddress, parseAddress, parseRange, type CellRange } from './address.js'
import { CHART_TYPES, assertChart, isRound, parseChartXml, type ChartType } from './chart.js'
import { OfficeError } from './errors.js'
import { attribute, child, children, descendants, readXml, relationshipId, relationships } from './ooxml.js'
import { assertColor, palette, type Theme } from './theme.js'

/**
 * xlsx 原生图表。exceljs 不能写图表，而且重新保存时会丢掉已有图表，所以图表由本模块在
 * exceljs 保存之后直接写进包里：图表部件、绘图锚点、关系与内容类型。系列引用单元格区域，
 * 缓存值来自公式求值，未重算的读者也能画出正确的图。
 */

export interface SheetChartSeries {
  /** 数值区域，例如 `B2:B5`，或带工作表 `'Data'!B2:B5`。 */
  values: string
  /** 系列名；缺省取数值区域上方的单元格（通常是表头）。 */
  name?: string
  color?: string
}

export interface SheetChartSpec {
  type: ChartType
  title?: string
  /** 类别区域，例如 `A2:A5`。 */
  categories: string
  series: SheetChartSeries[]
  stacked?: boolean
  legend?: boolean
  dataLabels?: boolean
  /** 图表左上角所在单元格，例如 `G2`。 */
  at: string
  /** 宽度（列数），缺省 8。 */
  width?: number
  /** 高度（行数），缺省 16。 */
  height?: number
}

/** 读回的图表：引用已规范成绝对地址并带工作表名。 */
export interface SheetChartOutline {
  index: number
  type: ChartType
  title?: string
  at: string
  categories: string
  series: { name: string, values: string }[]
}

/** 单元格值的读取接口：由调用方用已求值的工作簿实现。 */
export type CellReader = (sheet: string, row: number, column: number) => string | number | boolean | null

const NS = {
  c: 'http://schemas.openxmlformats.org/drawingml/2006/chart',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  xdr: 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing',
  rels: 'http://schemas.openxmlformats.org/package/2006/relationships',
}
const REL_TYPE = {
  drawing: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing',
  chart: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart',
}
const CONTENT_TYPE = {
  drawing: 'application/vnd.openxmlformats-officedocument.drawing+xml',
  chart: 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml',
}

// --- references -------------------------------------------------------------

export interface SheetRef {
  sheet: string
  range: CellRange
}

/** 解析 `A2:A5`、`Data!A2:A5` 或 `'My Data'!$A$2:$A$5`；没有工作表时用 `sheet`。 */
export function parseSheetRef(ref: string, sheet: string): SheetRef {
  const match = /^(?:'((?:[^']|'')+)'|([^'!]+))!(.+)$/.exec(ref.trim())
  if (!match) return { sheet, range: parseRange(ref) }
  return { sheet: match[1]?.replaceAll("''", "'") ?? match[2] ?? sheet, range: parseRange(match[3] ?? '') }
}

function quoteSheet(sheet: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(sheet) ? sheet : `'${sheet.replaceAll("'", "''")}'`
}

export function formatSheetRef(ref: SheetRef): string {
  const { start, end } = ref.range
  const cell = (position: { row: number, column: number }) => `$${columnName(position.column)}$${position.row}`
  const range = start.row === end.row && start.column === end.column ? cell(start) : `${cell(start)}:${cell(end)}`
  return `${quoteSheet(ref.sheet)}!${range}`
}

function cellsOf(range: CellRange): { row: number, column: number }[] {
  const cells: { row: number, column: number }[] = []
  for (let row = range.start.row; row <= range.end.row; row++) {
    for (let column = range.start.column; column <= range.end.column; column++) cells.push({ row, column })
  }
  return cells
}

// --- normalized model -------------------------------------------------------

/** 写入前的规范形：所有引用都是带工作表的绝对引用。 */
interface ResolvedChart {
  type: ChartType
  title?: string
  stacked: boolean
  legend: boolean
  dataLabels: boolean
  categories: SheetRef
  series: { values: SheetRef, name: { ref: SheetRef } | { text: string }, color?: string }[]
  from: { row: number, column: number }
  to: { row: number, column: number }
}

/** 缺省系列名：竖排数据取上方单元格，横排数据取左侧单元格；在表格边缘时用序号。 */
function headerOf(values: SheetRef, index: number): { ref: SheetRef } | { text: string } {
  const { start, end } = values.range
  const vertical = start.column === end.column
  const cell = vertical ? { row: start.row - 1, column: start.column } : { row: start.row, column: start.column - 1 }
  if (cell.row < 1 || cell.column < 1) return { text: `Series ${index + 1}` }
  return { ref: { sheet: values.sheet, range: { start: cell, end: cell } } }
}

function resolveChart(spec: SheetChartSpec, sheet: string, label: string): ResolvedChart {
  if (!CHART_TYPES.includes(spec.type)) throw new OfficeError(`${label}.type must be one of: ${CHART_TYPES.join(', ')}`, 'OFFICE_INVALID')
  if (!spec.series?.length) throw new OfficeError(`${label}.series must not be empty`, 'OFFICE_INVALID')
  if (spec.type === 'pie' && spec.series.length > 1) throw new OfficeError(`${label}: a pie chart has exactly one series`, 'OFFICE_INVALID')
  const at = parseAddress(spec.at)
  const width = spec.width ?? 8
  const height = spec.height ?? 16
  if (!(width >= 1 && width <= 100 && height >= 1 && height <= 500)) {
    throw new OfficeError(`${label}: width must be 1-100 columns and height 1-500 rows`, 'OFFICE_INVALID')
  }
  return {
    type: spec.type,
    ...(spec.title ? { title: spec.title } : {}),
    stacked: Boolean(spec.stacked),
    legend: spec.legend !== false,
    dataLabels: Boolean(spec.dataLabels),
    categories: parseSheetRef(spec.categories, sheet),
    series: spec.series.map((series, index) => {
      assertColor(series.color, `${label}.series[${index}].color`)
      const values = parseSheetRef(series.values, sheet)
      return {
        values,
        name: series.name !== undefined ? { text: series.name } : headerOf(values, index),
        ...(series.color ? { color: series.color.toUpperCase() } : {}),
      }
    }),
    from: at,
    to: { row: at.row + Math.round(height), column: at.column + Math.round(width) },
  }
}

function toOutline(chart: ResolvedChart, index: number, read: CellReader): SheetChartOutline {
  return {
    index,
    type: chart.type,
    ...(chart.title ? { title: chart.title } : {}),
    at: formatAddress(chart.from),
    categories: formatSheetRef(chart.categories),
    series: chart.series.map(series => ({
      name: 'text' in series.name ? series.name.text : String(read(series.name.ref.sheet, series.name.ref.range.start.row, series.name.ref.range.start.column) ?? ''),
      values: formatSheetRef(series.values),
    })),
  }
}

// --- chart XML ---------------------------------------------------------------

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function fill(color: string): string {
  return `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>`
}

function strCache(values: string[]): string {
  return `<c:strCache><c:ptCount val="${values.length}"/>${values.map((value, index) => `<c:pt idx="${index}"><c:v>${escapeXml(value)}</c:v></c:pt>`).join('')}</c:strCache>`
}

function numCache(values: (number | null)[]): string {
  const points = values.map((value, index) => (value === null ? '' : `<c:pt idx="${index}"><c:v>${value}</c:v></c:pt>`)).join('')
  return `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>${points}</c:numCache>`
}

function chartXml(chart: ResolvedChart, read: CellReader, theme: Theme | undefined): string {
  const scheme = palette(theme)
  const round = isRound(chart.type)
  const categoryCells = cellsOf(chart.categories.range)
  const categories = categoryCells.map(cell => {
    const value = read(chart.categories.sheet, cell.row, cell.column)
    return value === null ? '' : String(value)
  })
  const series = chart.series.map((series, index) => {
    const cells = cellsOf(series.values.range)
    const values = cells.map(cell => {
      const value = read(series.values.sheet, cell.row, cell.column)
      return typeof value === 'number' && Number.isFinite(value) ? value : null
    })
    const name = 'text' in series.name
      ? `<c:tx><c:v>${escapeXml(series.name.text)}</c:v></c:tx>`
      : `<c:tx><c:strRef><c:f>${escapeXml(formatSheetRef(series.name.ref))}</c:f>${strCache([String(read(series.name.ref.sheet, series.name.ref.range.start.row, series.name.ref.range.start.column) ?? '')])}</c:strRef></c:tx>`
    const color = series.color ?? scheme[index % scheme.length] ?? '4472C4'
    const style = chart.type === 'line'
      ? `<c:spPr><a:ln w="28575" cap="rnd">${fill(color)}<a:round/></a:ln></c:spPr><c:marker><c:symbol val="circle"/><c:size val="5"/><c:spPr>${fill(color)}</c:spPr></c:marker>`
      : round ? '' : `<c:spPr>${fill(color)}</c:spPr>`
    const points = round
      ? categories.map((_, point) => `<c:dPt><c:idx val="${point}"/><c:bubble3D val="0"/><c:spPr>${fill(scheme[point % scheme.length] ?? '4472C4')}<a:ln w="12700"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></c:spPr></c:dPt>`).join('')
      : ''
    const invert = chart.type === 'column' || chart.type === 'bar' ? '<c:invertIfNegative val="0"/>' : ''
    return `<c:ser><c:idx val="${index}"/><c:order val="${index}"/>${name}${style}${invert}${points}`
      + `<c:cat><c:strRef><c:f>${escapeXml(formatSheetRef(chart.categories))}</c:f>${strCache(categories)}</c:strRef></c:cat>`
      + `<c:val><c:numRef><c:f>${escapeXml(formatSheetRef(series.values))}</c:f>${numCache(values)}</c:numRef></c:val>`
      + `${chart.type === 'line' ? '<c:smooth val="0"/>' : ''}</c:ser>`
  }).join('')
  const labels = chart.dataLabels
    ? `<c:dLbls><c:showLegendKey val="0"/><c:showVal val="${round ? 0 : 1}"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="${round ? 1 : 0}"/><c:showBubbleSize val="0"/></c:dLbls>`
    : ''
  const axes = '<c:axId val="500000001"/><c:axId val="500000002"/>'
  const grouping = chart.stacked ? 'stacked' : chart.type === 'column' || chart.type === 'bar' ? 'clustered' : 'standard'
  let plot: string
  switch (chart.type) {
    case 'column':
    case 'bar':
      plot = `<c:barChart><c:barDir val="${chart.type === 'bar' ? 'bar' : 'col'}"/><c:grouping val="${grouping}"/><c:varyColors val="0"/>${series}${labels}<c:gapWidth val="150"/>${chart.stacked ? '<c:overlap val="100"/>' : ''}${axes}</c:barChart>`
      break
    case 'line':
      plot = `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}${labels}<c:marker val="1"/>${axes}</c:lineChart>`
      break
    case 'area':
      plot = `<c:areaChart><c:grouping val="${grouping}"/><c:varyColors val="0"/>${series}${labels}${axes}</c:areaChart>`
      break
    case 'pie':
      plot = `<c:pieChart><c:varyColors val="1"/>${series}${labels}<c:firstSliceAng val="0"/></c:pieChart>`
      break
    case 'doughnut':
      plot = `<c:doughnutChart><c:varyColors val="1"/>${series}${labels}<c:firstSliceAng val="0"/><c:holeSize val="50"/></c:doughnutChart>`
      break
  }
  const horizontal = chart.type === 'bar'
  const axisXml = round ? '' : `<c:catAx><c:axId val="500000001"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${horizontal ? 'l' : 'b'}"/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="500000002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`
    + `<c:valAx><c:axId val="500000002"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${horizontal ? 'b' : 'l'}"/><c:majorGridlines><c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="D9D9D9"/></a:solidFill></a:ln></c:spPr></c:majorGridlines><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="500000001"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>`
  const font = theme?.font ? `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr><a:latin typeface="${escapeXml(theme.font)}"/></a:defRPr></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>` : ''
  const title = chart.title
    ? `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1400" b="1"/></a:pPr><a:r><a:rPr lang="en-US" sz="1400" b="1"/><a:t>${escapeXml(chart.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>`
    : '<c:autoTitleDeleted val="1"/>'
  const legend = chart.legend ? '<c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend>' : ''
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + `<c:chartSpace xmlns:c="${NS.c}" xmlns:a="${NS.a}" xmlns:r="${NS.r}"><c:roundedCorners val="0"/>`
    + `<c:chart>${title}<c:plotArea><c:layout/>${plot}${axisXml}</c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>${font}</c:chartSpace>`
}

function anchorXml(chart: ResolvedChart, id: number, relId: string): string {
  const marker = (tag: string, position: { row: number, column: number }) =>
    `<xdr:${tag}><xdr:col>${position.column - 1}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${position.row - 1}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:${tag}>`
  return `<xdr:twoCellAnchor editAs="oneCell">${marker('from', chart.from)}${marker('to', chart.to)}`
    + `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${id}" name="Chart ${id}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>`
    + '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>'
    + `<a:graphic><a:graphicData uri="${NS.c}"><c:chart xmlns:c="${NS.c}" xmlns:r="${NS.r}" r:id="${relId}"/></a:graphicData></a:graphic>`
    + '</xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>'
}

// --- package plumbing --------------------------------------------------------

function parse(xml: string): Document {
  return new DOMParser().parseFromString(xml, 'text/xml')
}

function serialize(document: Document): string {
  return new XMLSerializer().serializeToString(document)
}

function partDirectory(path: string): string {
  return path.slice(0, path.lastIndexOf('/'))
}

function relsPath(path: string): string {
  return `${partDirectory(path)}/_rels/${path.slice(path.lastIndexOf('/') + 1)}.rels`
}

function relativeTarget(from: string, to: string): string {
  const fromParts = partDirectory(from).split('/')
  const toParts = to.split('/')
  let common = 0
  while (common < fromParts.length && fromParts[common] === toParts[common]) common++
  return [...fromParts.slice(common).map(() => '..'), ...toParts.slice(common)].join('/')
}

/** 给某个部件追加一条关系，返回新的 `rId`。 */
async function addRelationship(zip: JSZip, source: string, type: string, target: string): Promise<string> {
  const path = relsPath(source)
  const existing = await zip.file(path)?.async('string')
  const document = parse(existing ?? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS.rels}"></Relationships>`)
  const ids = new Set(descendants(document, 'Relationship').map(rel => rel.getAttribute('Id')))
  let next = ids.size + 1
  while (ids.has(`rId${next}`)) next++
  const rel = document.createElementNS(NS.rels, 'Relationship')
  rel.setAttribute('Id', `rId${next}`)
  rel.setAttribute('Type', type)
  rel.setAttribute('Target', relativeTarget(source, target))
  document.documentElement?.appendChild(rel)
  zip.file(path, serialize(document))
  return `rId${next}`
}

async function addContentType(zip: JSZip, part: string, contentType: string): Promise<void> {
  const document = parse((await zip.file('[Content_Types].xml')?.async('string')) ?? '')
  const name = `/${part}`
  if (descendants(document, 'Override').some(node => node.getAttribute('PartName') === name)) return
  const override = document.createElementNS('http://schemas.openxmlformats.org/package/2006/content-types', 'Override')
  override.setAttribute('PartName', name)
  override.setAttribute('ContentType', contentType)
  document.documentElement?.appendChild(override)
  zip.file('[Content_Types].xml', serialize(document))
}

function nextPartPath(zip: JSZip, directory: string, stem: string): string {
  for (let index = 1; ; index++) {
    const path = `${directory}/${stem}${index}.xml`
    if (!zip.file(path)) return path
  }
}

/** 工作表名 → 工作表部件路径。 */
async function sheetParts(zip: JSZip): Promise<Map<string, string>> {
  const workbook = await readXml(zip, 'xl/workbook.xml')
  const rels = await relationships(zip, 'xl/_rels/workbook.xml.rels', 'xl')
  const parts = new Map<string, string>()
  for (const sheet of workbook ? descendants(workbook, 'sheet') : []) {
    const name = sheet.getAttribute('name')
    const target = rels.get(relationshipId(sheet) ?? '')
    if (name && target) parts.set(name, target)
  }
  return parts
}

/** `<drawing>` 在 CT_Worksheet 中必须排在这些元素之前。 */
const AFTER_DRAWING = new Set(['legacyDrawing', 'legacyDrawingHF', 'drawingHF', 'picture', 'oleObjects', 'controls', 'webPublishItems', 'tableParts', 'extLst'])

/** 取得工作表的绘图部件，没有就新建并挂到工作表上。 */
async function ensureDrawing(zip: JSZip, sheetPath: string): Promise<string> {
  const sheetXml = parse((await zip.file(sheetPath)?.async('string')) ?? '')
  const root = sheetXml.documentElement
  if (!root) throw new OfficeError(`broken worksheet part: ${sheetPath}`, 'OFFICE_INVALID')
  const existing = child(root, 'drawing')
  if (existing) {
    const rels = await relationships(zip, relsPath(sheetPath), partDirectory(sheetPath))
    const target = rels.get(relationshipId(existing) ?? '')
    if (target) return target
  }
  const drawingPath = nextPartPath(zip, 'xl/drawings', 'drawing')
  zip.file(drawingPath, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="${NS.xdr}" xmlns:a="${NS.a}"></xdr:wsDr>`)
  await addContentType(zip, drawingPath, CONTENT_TYPE.drawing)
  const relId = await addRelationship(zip, sheetPath, REL_TYPE.drawing, drawingPath)
  const drawing = sheetXml.createElementNS(root.namespaceURI ?? '', 'drawing')
  drawing.setAttributeNS(NS.r, 'r:id', relId)
  const before = children(root).find(element => AFTER_DRAWING.has(element.localName ?? ''))
  if (before) root.insertBefore(drawing, before)
  else root.appendChild(drawing)
  zip.file(sheetPath, serialize(sheetXml))
  return drawingPath
}

/** 把图表写进已由 exceljs 保存的包。`charts` 以工作表名为键。 */
export async function writeCharts(zip: JSZip, charts: ReadonlyMap<string, readonly SheetChartSpec[]>, read: CellReader, theme: Theme | undefined): Promise<void> {
  const parts = await sheetParts(zip)
  for (const [sheet, specs] of charts) {
    if (specs.length === 0) continue
    const sheetPath = parts.get(sheet)
    if (!sheetPath) throw new OfficeError(`no sheet named "${sheet}" for chart`, 'OFFICE_INVALID')
    const drawingPath = await ensureDrawing(zip, sheetPath)
    const drawing = parse((await zip.file(drawingPath)?.async('string')) ?? '')
    const used = descendants(drawing, 'cNvPr').map(node => Number(node.getAttribute('id')) || 0)
    let id = Math.max(1, ...used)
    for (const [index, spec] of specs.entries()) {
      const chart = resolveChart(spec, sheet, `charts[${index}]`)
      const chartPath = nextPartPath(zip, 'xl/charts', 'chart')
      zip.file(chartPath, chartXml(chart, read, theme))
      await addContentType(zip, chartPath, CONTENT_TYPE.chart)
      const relId = await addRelationship(zip, drawingPath, REL_TYPE.chart, chartPath)
      const anchor = parse(`<root xmlns:xdr="${NS.xdr}" xmlns:a="${NS.a}">${anchorXml(chart, ++id, relId)}</root>`)
      const node = anchor.documentElement?.firstChild
      if (node) drawing.documentElement?.appendChild(drawing.importNode(node, true))
    }
    zip.file(drawingPath, serialize(drawing))
  }
}

// --- reading -----------------------------------------------------------------

function anchorCell(anchor: Element, tag: 'from' | 'to'): { row: number, column: number } {
  const marker = child(anchor, tag)
  return {
    row: Number(child(marker ?? anchor, 'row')?.textContent ?? 0) + 1,
    column: Number(child(marker ?? anchor, 'col')?.textContent ?? 0) + 1,
  }
}

/** 一张工作表上的图表，还原成可重新写入的规格；无法如实还原时 `supported` 为 false。 */
export interface FoundChart {
  sheet: string
  spec?: SheetChartSpec
  supported: boolean
  reason?: string
}

export async function readCharts(zip: JSZip): Promise<FoundChart[]> {
  const found: FoundChart[] = []
  for (const [sheet, sheetPath] of await sheetParts(zip)) {
    const sheetXml = await readXml(zip, sheetPath)
    const drawingRef = sheetXml?.documentElement ? child(sheetXml.documentElement, 'drawing') : undefined
    if (!drawingRef) continue
    const sheetRels = await relationships(zip, relsPath(sheetPath), partDirectory(sheetPath))
    const drawingPath = sheetRels.get(relationshipId(drawingRef) ?? '')
    const drawing = drawingPath ? await readXml(zip, drawingPath) : undefined
    if (!drawingPath || !drawing) continue
    const drawingRels = await relationships(zip, relsPath(drawingPath), partDirectory(drawingPath))
    for (const anchor of [...descendants(drawing, 'twoCellAnchor'), ...descendants(drawing, 'oneCellAnchor')]) {
      const reference = descendants(anchor, 'chart')[0]
      if (!reference) continue
      const chartPath = drawingRels.get(relationshipId(reference) ?? '')
      const chartXmlDocument = chartPath ? await readXml(zip, chartPath) : undefined
      if (!chartXmlDocument) {
        found.push({ sheet, supported: false, reason: 'missing chart part' })
        continue
      }
      const read = parseChartXml(chartXmlDocument)
      if (read.type === 'other' || !read.categoriesRef || read.series.some(series => !series.valuesRef)) {
        found.push({ sheet, supported: false, reason: `a ${read.type === 'other' ? 'chart type' : 'chart without cell references'} this tool cannot rebuild` })
        continue
      }
      const from = anchorCell(anchor, 'from')
      const to = anchor.localName === 'twoCellAnchor' ? anchorCell(anchor, 'to') : { row: from.row + 16, column: from.column + 8 }
      const plot = descendants(chartXmlDocument, 'plotArea')[0]
      const showVal = plot ? descendants(plot, 'showVal')[0]?.getAttribute('val') === '1' || descendants(plot, 'showPercent')[0]?.getAttribute('val') === '1' : false
      const colors = plot ? children(children(plot).find(element => element.localName?.endsWith('Chart')) ?? plot, 'ser').map(ser => {
        const own = child(ser, 'spPr')
        return own ? attribute(descendants(own, 'srgbClr')[0], 'val') : undefined
      }) : []
      found.push({
        sheet,
        supported: true,
        spec: {
          type: read.type,
          ...(read.title ? { title: read.title } : {}),
          categories: read.categoriesRef,
          series: read.series.map((series, index) => ({
            values: series.valuesRef ?? '',
            ...(series.nameRef ? {} : { name: series.name }),
            ...(colors[index] && !isRound(read.type === 'other' ? 'column' : read.type) ? { color: colors[index] } : {}),
          })),
          ...(read.stacked ? { stacked: true } : {}),
          ...(descendants(chartXmlDocument, 'legend').length === 0 ? { legend: false } : {}),
          ...(showVal ? { dataLabels: true } : {}),
          at: formatAddress(from),
          width: Math.max(1, to.column - from.column),
          height: Math.max(1, to.row - from.row),
        },
      })
    }
  }
  return found
}

/** 已读回的图表规格转成大纲；引用规范成带工作表的绝对地址。 */
export function outlineCharts(sheet: string, specs: readonly SheetChartSpec[], read: CellReader): SheetChartOutline[] {
  return specs.map((spec, index) => toOutline(resolveChart(spec, sheet, `charts[${index}]`), index, read))
}

/** 工作表改名后，改写所有图表里指向旧名的引用。 */
export function renameInCharts(specs: readonly SheetChartSpec[], chartSheet: string, from: string, to: string): SheetChartSpec[] {
  const rename = (ref: string): string => {
    const parsed = parseSheetRef(ref, chartSheet)
    return formatSheetRef(parsed.sheet === from ? { ...parsed, sheet: to } : parsed)
  }
  return specs.map(spec => ({
    ...spec,
    categories: rename(spec.categories),
    series: spec.series.map(series => ({ ...series, values: rename(series.values) })),
  }))
}

/** 图表是否引用了某张工作表。 */
export function chartReferences(spec: SheetChartSpec, chartSheet: string, sheet: string): boolean {
  return [spec.categories, ...spec.series.map(series => series.values)]
    .some(ref => parseSheetRef(ref, chartSheet).sheet === sheet)
}

export function assertSheetChart(spec: SheetChartSpec, sheet: string, label: string): void {
  resolveChart(spec, sheet, label)
  // 复用通用校验的颜色与类型规则；数值来自单元格，因此只检查结构。
  assertChart({ type: spec.type, categories: ['x'], series: spec.series.map((series, index) => ({ name: series.name ?? `s${index}`, values: [], ...(series.color ? { color: series.color } : {}) })) }, label)
}
