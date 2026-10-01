import type { Document, Element } from '@xmldom/xmldom'
import { OfficeError } from './errors.js'
import { child, children, descendants } from './ooxml.js'
import { assertColor } from './theme.js'

/**
 * 三种格式共用的图表描述。docx / pptx 的图表数据随文件内嵌；xlsx 的图表引用单元格区域，
 * 见 `xlsx-chart.ts`。
 */
export type ChartType = 'column' | 'bar' | 'line' | 'area' | 'pie' | 'doughnut'

export const CHART_TYPES: readonly ChartType[] = ['column', 'bar', 'line', 'area', 'pie', 'doughnut']

export interface ChartSeriesSpec {
  name: string
  /** 每个类别一个值；`null` 留空。 */
  values: (number | null)[]
  /** 系列颜色，6 位十六进制 RGB；缺省按主题配色。 */
  color?: string
}

export interface ChartSpec {
  type: ChartType
  title?: string
  categories: string[]
  series: ChartSeriesSpec[]
  /** 柱、条、面积图按系列堆叠。 */
  stacked?: boolean
  /** 缺省显示图例。 */
  legend?: boolean
  /** 在柱或扇区上显示数值（饼图显示百分比）。 */
  dataLabels?: boolean
}

export function isRound(type: ChartType): boolean {
  return type === 'pie' || type === 'doughnut'
}

export function assertChart(spec: ChartSpec, label = 'chart'): void {
  if (!CHART_TYPES.includes(spec.type)) {
    throw new OfficeError(`${label}.type must be one of: ${CHART_TYPES.join(', ')}`, 'OFFICE_INVALID')
  }
  if (!spec.categories?.length) throw new OfficeError(`${label}.categories must not be empty`, 'OFFICE_INVALID')
  if (!spec.series?.length) throw new OfficeError(`${label}.series must not be empty`, 'OFFICE_INVALID')
  if (spec.type === 'pie' && spec.series.length > 1) {
    throw new OfficeError(`${label}: a pie chart has exactly one series`, 'OFFICE_INVALID')
  }
  spec.series.forEach((series, index) => {
    assertColor(series.color, `${label}.series[${index}].color`)
    if (series.values.length > spec.categories.length) {
      throw new OfficeError(`${label}.series[${index}] has more values than there are categories`, 'OFFICE_INVALID')
    }
    for (const value of series.values) {
      if (value !== null && !Number.isFinite(value)) {
        throw new OfficeError(`${label}.series[${index}].values must be finite numbers or null`, 'OFFICE_INVALID')
      }
      if (value !== null && value < 0 && isRound(spec.type)) {
        throw new OfficeError(`${label}: ${spec.type} charts cannot show negative values`, 'OFFICE_INVALID')
      }
    }
  })
}

/** 从文件里读回的图表：数据来自图表部件内的缓存，xlsx 图表另带单元格引用。 */
export interface ChartRead {
  type: ChartType | 'other'
  title?: string
  stacked?: boolean
  categories: string[]
  /** 类别的单元格引用，例如 `Sheet1!$A$2:$A$5`（只有引用工作表的图表才有）。 */
  categoriesRef?: string
  series: { name: string, values: (number | null)[], nameRef?: string, valuesRef?: string }[]
}

const PLOT_TYPES: Record<string, ChartType> = {
  lineChart: 'line', line3DChart: 'line',
  areaChart: 'area', area3DChart: 'area',
  pieChart: 'pie', pie3DChart: 'pie',
  doughnutChart: 'doughnut',
}

function value(element: Element | undefined, name: string): string | undefined {
  const found = element ? child(element, name) : undefined
  return found?.getAttribute('val') ?? undefined
}

function text(element: Element | undefined): string {
  return element ? descendants(element, 't').map(node => node.textContent ?? '').join('') : ''
}

/** 一个数据源（`c:tx` / `c:cat` / `c:val`）的引用与缓存点。 */
function source(element: Element | undefined): { ref?: string, points: string[] } {
  if (!element) return { points: [] }
  const ref = descendants(element, 'f')[0]?.textContent ?? undefined
  const count = Number(descendants(element, 'ptCount')[0]?.getAttribute('val') ?? 0)
  const points: string[] = Array.from({ length: count }, () => '')
  for (const point of descendants(element, 'pt')) {
    const index = Number(point.getAttribute('idx'))
    if (Number.isInteger(index) && index >= 0) points[index] = child(point, 'v')?.textContent ?? ''
  }
  // 没有缓存、只有字面值的系列名（`c:tx/c:v`）。
  if (points.length === 0) {
    const literal = child(element, 'v')?.textContent
    if (literal !== undefined && literal !== null) points.push(literal)
  }
  return { ...(ref ? { ref } : {}), points }
}

export function parseChartXml(document: Document): ChartRead {
  const plotArea = descendants(document, 'plotArea')[0]
  const plot = plotArea ? children(plotArea).find(element => element.localName?.endsWith('Chart')) : undefined
  const plotName = plot?.localName ?? ''
  let type: ChartType | 'other' = PLOT_TYPES[plotName] ?? 'other'
  if (plotName === 'barChart' || plotName === 'bar3DChart') type = value(plot, 'barDir') === 'bar' ? 'bar' : 'column'
  const grouping = value(plot, 'grouping')
  const titleElement = descendants(document, 'chart')[0]
  const title = titleElement ? text(child(titleElement, 'title')) : ''
  let categories: string[] = []
  let categoriesRef: string | undefined
  const series = plot ? children(plot, 'ser').map(ser => {
    const name = source(child(ser, 'tx'))
    const cat = source(child(ser, 'cat'))
    const val = source(child(ser, 'val'))
    if (categories.length === 0 && cat.points.length) categories = cat.points
    categoriesRef ??= cat.ref
    return {
      name: name.points[0] ?? '',
      values: val.points.map(point => (point === '' || !Number.isFinite(Number(point)) ? null : Number(point))),
      ...(name.ref ? { nameRef: name.ref } : {}),
      ...(val.ref ? { valuesRef: val.ref } : {}),
    }
  }) : []
  return {
    type,
    ...(title ? { title } : {}),
    ...(grouping === 'stacked' || grouping === 'percentStacked' ? { stacked: true } : {}),
    categories,
    ...(categoriesRef ? { categoriesRef } : {}),
    series,
  }
}
