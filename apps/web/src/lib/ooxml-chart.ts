import type JSZip from 'jszip'

/**
 * Read native charts out of an OOXML package in the browser, for previews that
 * cannot draw them themselves. Values come from the caches inside each chart
 * part, which the server fills in when it writes the file.
 */

export type ChartKind = 'column' | 'bar' | 'line' | 'area' | 'pie' | 'doughnut' | 'other'

export interface ChartView {
  kind: ChartKind
  title?: string
  stacked: boolean
  categories: string[]
  series: Array<{ name: string; values: Array<number | null>; color?: string }>
  /** Top-left cell of an xlsx chart, e.g. `F2`. */
  anchor?: string
}

const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

function elements(parent: Element | Document, name: string): Element[] {
  return Array.from(parent.getElementsByTagNameNS('*', name))
}

function first(parent: Element | Document | undefined, name: string): Element | undefined {
  return parent ? elements(parent, name)[0] : undefined
}

function directChildren(parent: Element, name?: string): Element[] {
  return Array.from(parent.children).filter(child => name === undefined || child.localName === name)
}

function points(source: Element | undefined): string[] {
  if (!source) return []
  const count = Number(first(source, 'ptCount')?.getAttribute('val') ?? 0)
  const values = Array.from({ length: count }, () => '')
  for (const point of elements(source, 'pt')) {
    const index = Number(point.getAttribute('idx'))
    if (Number.isInteger(index) && index >= 0) values[index] = first(point, 'v')?.textContent ?? ''
  }
  if (values.length === 0) {
    const literal = directChildren(source, 'v')[0]?.textContent
    if (literal) values.push(literal)
  }
  return values
}

const PLOTS: Record<string, ChartKind> = {
  lineChart: 'line', line3DChart: 'line', areaChart: 'area', area3DChart: 'area',
  pieChart: 'pie', pie3DChart: 'pie', doughnutChart: 'doughnut',
}

export function parseChart(xml: string): ChartView {
  const document = new DOMParser().parseFromString(xml, 'application/xml')
  const plotArea = first(document, 'plotArea')
  const plot = plotArea ? directChildren(plotArea).find(child => child.localName.endsWith('Chart')) : undefined
  const name = plot?.localName ?? ''
  let kind: ChartKind = PLOTS[name] ?? 'other'
  if (name === 'barChart' || name === 'bar3DChart') kind = first(plot, 'barDir')?.getAttribute('val') === 'bar' ? 'bar' : 'column'
  const grouping = first(plot, 'grouping')?.getAttribute('val')
  const chart = first(document, 'chart')
  const titleElement = chart ? directChildren(chart, 'title')[0] : undefined
  const title = titleElement ? elements(titleElement, 't').map(node => node.textContent ?? '').join('') : ''
  let categories: string[] = []
  const series = plot ? directChildren(plot, 'ser').map(ser => {
    const category = points(directChildren(ser, 'cat')[0])
    if (categories.length === 0) categories = category
    const spPr = directChildren(ser, 'spPr')[0]
    const color = spPr ? first(spPr, 'srgbClr')?.getAttribute('val') ?? undefined : undefined
    return {
      name: points(directChildren(ser, 'tx')[0])[0] ?? '',
      values: points(directChildren(ser, 'val')[0]).map(value => (value === '' || !Number.isFinite(Number(value)) ? null : Number(value))),
      ...(color ? { color: `#${color}` } : {}),
    }
  }) : []
  return {
    kind,
    ...(title ? { title } : {}),
    stacked: grouping === 'stacked' || grouping === 'percentStacked',
    categories,
    series,
  }
}

async function xml(zip: JSZip, path: string): Promise<Document | undefined> {
  const text = await zip.file(path)?.async('string')
  return text === undefined ? undefined : new DOMParser().parseFromString(text, 'application/xml')
}

function resolve(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = base.split('/').filter(Boolean)
  for (const segment of target.split('/')) {
    if (segment === '..') parts.pop()
    else if (segment !== '.') parts.push(segment)
  }
  return parts.join('/')
}

async function rels(zip: JSZip, part: string): Promise<Map<string, string>> {
  const directory = part.slice(0, part.lastIndexOf('/'))
  const file = part.slice(part.lastIndexOf('/') + 1)
  const document = await xml(zip, `${directory}/_rels/${file}.rels`)
  const map = new Map<string, string>()
  for (const rel of document ? elements(document, 'Relationship') : []) {
    const id = rel.getAttribute('Id')
    const target = rel.getAttribute('Target')
    if (id && target) map.set(id, resolve(directory, target))
  }
  return map
}

function columnName(index: number): string {
  let name = ''
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name
  return name
}

/** Charts on each worksheet of an xlsx package, keyed by sheet name. */
export async function workbookCharts(zip: JSZip): Promise<Map<string, ChartView[]>> {
  const result = new Map<string, ChartView[]>()
  const workbook = await xml(zip, 'xl/workbook.xml')
  const workbookRels = await rels(zip, 'xl/workbook.xml')
  for (const sheet of workbook ? elements(workbook, 'sheet') : []) {
    const sheetPath = workbookRels.get(sheet.getAttributeNS(R, 'id') ?? '')
    const sheetXml = sheetPath ? await xml(zip, sheetPath) : undefined
    const drawingRef = sheetXml?.documentElement ? directChildren(sheetXml.documentElement, 'drawing')[0] : undefined
    if (!sheetPath || !drawingRef) continue
    const drawingPath = (await rels(zip, sheetPath)).get(drawingRef.getAttributeNS(R, 'id') ?? '')
    const drawing = drawingPath ? await xml(zip, drawingPath) : undefined
    if (!drawingPath || !drawing) continue
    const drawingRels = await rels(zip, drawingPath)
    const charts: ChartView[] = []
    for (const anchor of [...elements(drawing, 'twoCellAnchor'), ...elements(drawing, 'oneCellAnchor')]) {
      const reference = Array.from(anchor.getElementsByTagNameNS(C, 'chart'))[0]
      const chartPath = reference ? drawingRels.get(reference.getAttributeNS(R, 'id') ?? '') : undefined
      const text = chartPath ? await zip.file(chartPath)?.async('string') : undefined
      if (!text) continue
      const from = first(anchor, 'from')
      const column = Number(first(from, 'col')?.textContent ?? 0)
      const row = Number(first(from, 'row')?.textContent ?? 0)
      charts.push({ ...parseChart(text), anchor: `${columnName(column)}${row + 1}` })
    }
    if (charts.length) result.set(sheet.getAttribute('name') ?? '', charts)
  }
  return result
}

/** Charts embedded in a docx body, in document order. */
export async function documentCharts(zip: JSZip): Promise<ChartView[]> {
  const document = await xml(zip, 'word/document.xml')
  if (!document) return []
  const documentRels = await rels(zip, 'word/document.xml')
  const charts: ChartView[] = []
  for (const reference of Array.from(document.getElementsByTagNameNS(C, 'chart'))) {
    const path = documentRels.get(reference.getAttributeNS(R, 'id') ?? '')
    const text = path ? await zip.file(path)?.async('string') : undefined
    if (text) charts.push(parseChart(text))
  }
  return charts
}
