import type {
  DocumentOp,
  PresentationOp,
  CellInput,
  ChartSpec,
  ChartType,
  PageSetup,
  SheetChartSpec,
  Theme,
  CellStyle,
  DocBlock,
  DocumentSpec,
  Inline,
  PresentationSpec,
  RangeStyle,
  SheetSpec,
  SlideSpec,
  TextSpan,
  WorkbookOp,
  WorkbookSpec,
} from '@tnega/office'
import { ToolInputError } from '@tnega/tools'

/**
 * 模型给出的结构化描述是 `unknown`：这里逐字段校验并构造出 `@tnega/office` 的类型，
 * 错误信息带上字段路径，让模型能自行修正。
 */

export function record(value: unknown, label = 'input'): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return Object.fromEntries(Object.entries(value))
  throw new ToolInputError(`${label} must be an object`)
}

export function stringField(value: unknown, label: string): string {
  if (typeof value === 'string') return value
  throw new ToolInputError(`${label} must be a string`)
}

export function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : stringField(value, label)
}

export function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw new ToolInputError(`${label} must be a finite number`)
}

export function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'boolean') return value
  throw new ToolInputError(`${label} must be a boolean`)
}

function array(value: unknown, label: string): unknown[] {
  if (Array.isArray(value)) return value
  throw new ToolInputError(`${label} must be an array`)
}

function oneOf<const T extends string>(value: unknown, options: readonly T[], label: string): T {
  const found = options.find(option => option === value)
  if (found === undefined) throw new ToolInputError(`${label} must be one of: ${options.join(', ')}`)
  return found
}

/** 可选字段：缺省时不出现该键（`exactOptionalPropertyTypes` 下不能写 `undefined`）。 */
function optional<K extends string, T>(key: K, value: T | undefined): { [P in K]?: T } {
  const result: { [P in K]?: T } = {}
  if (value !== undefined) result[key] = value
  return result
}

function strings(value: unknown, label: string): string[] {
  return array(value, label).map((each, index) => stringField(each, `${label}[${index}]`))
}

// shared

export function theme(value: unknown, label = 'spec.theme'): Theme | undefined {
  if (value === undefined) return undefined
  const input = record(value, label)
  return {
    ...optional('font', optionalString(input.font, `${label}.font`)),
    ...optional('headingFont', optionalString(input.headingFont, `${label}.headingFont`)),
    ...optional('accent', optionalString(input.accent, `${label}.accent`)),
  }
}

const CHART_TYPES: readonly ChartType[] = ['column', 'bar', 'line', 'area', 'pie', 'doughnut']

function chartOptions(input: Record<string, unknown>, label: string) {
  return {
    type: oneOf(input.type, CHART_TYPES, `${label}.type`),
    ...optional('title', optionalString(input.title, `${label}.title`)),
    ...optional('stacked', optionalBoolean(input.stacked, `${label}.stacked`)),
    ...optional('legend', optionalBoolean(input.legend, `${label}.legend`)),
    ...optional('dataLabels', optionalBoolean(input.dataLabels, `${label}.dataLabels`)),
  }
}

/** docx / pptx 图表：数据直接写在规格里。 */
export function chartSpec(value: unknown, label: string): ChartSpec {
  const input = record(value, label)
  return {
    ...chartOptions(input, label),
    categories: array(input.categories, `${label}.categories`).map(each => String(each)),
    series: array(input.series, `${label}.series`).map((each, index) => {
      const series = record(each, `${label}.series[${index}]`)
      return {
        name: stringField(series.name, `${label}.series[${index}].name`),
        values: array(series.values, `${label}.series[${index}].values`).map((point, p) => {
          if (point === null) return null
          const number = optionalNumber(point, `${label}.series[${index}].values[${p}]`)
          return number ?? null
        }),
        ...optional('color', optionalString(series.color, `${label}.series[${index}].color`)),
      }
    }),
  }
}

/** xlsx 图表：类别与系列引用单元格区域。 */
function sheetChart(value: unknown, label: string): SheetChartSpec {
  const input = record(value, label)
  return {
    ...chartOptions(input, label),
    categories: stringField(input.categories, `${label}.categories`),
    series: array(input.series, `${label}.series`).map((each, index) => {
      const series = record(each, `${label}.series[${index}]`)
      return {
        values: stringField(series.values, `${label}.series[${index}].values`),
        ...optional('name', optionalString(series.name, `${label}.series[${index}].name`)),
        ...optional('color', optionalString(series.color, `${label}.series[${index}].color`)),
      }
    }),
    at: stringField(input.at, `${label}.at`),
    ...optional('width', optionalNumber(input.width, `${label}.width`)),
    ...optional('height', optionalNumber(input.height, `${label}.height`)),
  }
}

// xlsx

function cell(value: unknown, label: string): CellInput {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { formula: stringField(record(value, label).formula, `${label}.formula`) }
  }
  throw new ToolInputError(`${label} must be a string, number, boolean, null or { formula }`)
}

function rows(value: unknown, label: string): CellInput[][] {
  return array(value, label).map((row, r) => array(row, `${label}[${r}]`).map((each, c) => cell(each, `${label}[${r}][${c}]`)))
}

function cellStyle(value: unknown, label: string): CellStyle {
  const input = record(value, label)
  const pick = <const T extends string>(key: string, options: readonly T[]): T | undefined =>
    input[key] === undefined ? undefined : oneOf(input[key], options, `${label}.${key}`)
  return {
    ...optional('bold', optionalBoolean(input.bold, `${label}.bold`)),
    ...optional('italic', optionalBoolean(input.italic, `${label}.italic`)),
    ...optional('underline', optionalBoolean(input.underline, `${label}.underline`)),
    ...optional('font', optionalString(input.font, `${label}.font`)),
    ...optional('size', optionalNumber(input.size, `${label}.size`)),
    ...optional('color', optionalString(input.color, `${label}.color`)),
    ...optional('numFmt', optionalString(input.numFmt, `${label}.numFmt`)),
    ...optional('fill', optionalString(input.fill, `${label}.fill`)),
    ...optional('align', pick('align', ['left', 'center', 'right'])),
    ...optional('valign', pick('valign', ['top', 'middle', 'bottom'])),
    ...optional('wrap', optionalBoolean(input.wrap, `${label}.wrap`)),
    ...optional('border', pick('border', ['thin', 'medium', 'thick', 'none'])),
    ...optional('borderColor', optionalString(input.borderColor, `${label}.borderColor`)),
  }
}

function numbers(value: unknown, label: string): number[] {
  return array(value, label).map((each, index) => {
    const number = optionalNumber(each, `${label}[${index}]`)
    if (number === undefined) throw new ToolInputError(`${label}[${index}] must be a number`)
    return number
  })
}

function sheet(value: unknown, label: string): SheetSpec {
  const input = record(value, label)
  const freeze = input.freeze === undefined ? undefined : record(input.freeze, `${label}.freeze`)
  const styles: RangeStyle[] | undefined = input.styles === undefined
    ? undefined
    : array(input.styles, `${label}.styles`).map((each, index) => {
      const style = record(each, `${label}.styles[${index}]`)
      return { range: stringField(style.range, `${label}.styles[${index}].range`), style: cellStyle(style.style, `${label}.styles[${index}].style`) }
    })
  return {
    name: stringField(input.name, `${label}.name`),
    ...(input.rows !== undefined ? { rows: rows(input.rows, `${label}.rows`) } : {}),
    ...(input.columnWidths !== undefined ? { columnWidths: numbers(input.columnWidths, `${label}.columnWidths`) } : {}),
    ...(freeze ? {
      freeze: {
        ...optional('rows', optionalNumber(freeze.rows, `${label}.freeze.rows`)),
        ...optional('columns', optionalNumber(freeze.columns, `${label}.freeze.columns`)),
      },
    } : {}),
    ...(styles ? { styles } : {}),
    ...(input.merges !== undefined ? { merges: strings(input.merges, `${label}.merges`) } : {}),
    ...(input.rowHeights !== undefined ? { rowHeights: numbers(input.rowHeights, `${label}.rowHeights`) } : {}),
    ...optional('autoFilter', optionalString(input.autoFilter, `${label}.autoFilter`)),
    ...(input.charts !== undefined
      ? { charts: array(input.charts, `${label}.charts`).map((each, index) => sheetChart(each, `${label}.charts[${index}]`)) }
      : {}),
  }
}

export function workbookSpec(value: unknown): WorkbookSpec {
  const input = record(value, 'spec')
  return {
    ...optional('theme', theme(input.theme)),
    sheets: array(input.sheets, 'spec.sheets').map((each, index) => sheet(each, `spec.sheets[${index}]`)),
  }
}

const WORKBOOK_OPS = [
  'setCells', 'clear', 'style', 'setColumnWidths', 'setRowHeights', 'merge', 'unmerge', 'autoFilter',
  'addChart', 'removeChart', 'addSheet', 'renameSheet', 'deleteSheet',
] as const

function workbookOp(value: unknown, label: string): WorkbookOp {
  const input = record(value, label)
  const field = (key: string): string => stringField(input[key], `${label}.${key}`)
  switch (oneOf(input.op, WORKBOOK_OPS, `${label}.op`)) {
    case 'setCells': return { op: 'setCells', sheet: field('sheet'), start: field('start'), rows: rows(input.rows, `${label}.rows`) }
    case 'clear': return { op: 'clear', sheet: field('sheet'), range: field('range') }
    case 'style': return { op: 'style', sheet: field('sheet'), range: field('range'), style: cellStyle(input.style, `${label}.style`) }
    case 'setColumnWidths': return {
      op: 'setColumnWidths',
      sheet: field('sheet'),
      ...optional('start', optionalString(input.start, `${label}.start`)),
      widths: numbers(input.widths, `${label}.widths`),
    }
    case 'setRowHeights': return {
      op: 'setRowHeights',
      sheet: field('sheet'),
      ...optional('start', optionalNumber(input.start, `${label}.start`)),
      heights: numbers(input.heights, `${label}.heights`),
    }
    case 'merge': return { op: 'merge', sheet: field('sheet'), range: field('range') }
    case 'unmerge': return { op: 'unmerge', sheet: field('sheet'), range: field('range') }
    case 'autoFilter': return { op: 'autoFilter', sheet: field('sheet'), range: input.range === null ? null : field('range') }
    case 'addChart': return { op: 'addChart', sheet: field('sheet'), chart: sheetChart(input.chart, `${label}.chart`) }
    case 'removeChart': {
      const index = optionalNumber(input.index, `${label}.index`)
      if (index === undefined) throw new ToolInputError(`${label}.index must be a number`)
      return { op: 'removeChart', sheet: field('sheet'), index }
    }
    case 'addSheet': return { op: 'addSheet', name: field('name') }
    case 'renameSheet': return { op: 'renameSheet', sheet: field('sheet'), name: field('name') }
    case 'deleteSheet': return { op: 'deleteSheet', sheet: field('sheet') }
  }
}

export function workbookOps(value: unknown): WorkbookOp[] {
  const ops = array(value, 'ops')
  if (ops.length === 0) throw new ToolInputError('ops must not be empty')
  return ops.map((each, index) => workbookOp(each, `ops[${index}]`))
}

// docx

function inline(value: unknown, label: string): Inline {
  if (typeof value === 'string') return value
  return array(value, label).map((each, index): TextSpan => {
    const span = record(each, `${label}[${index}]`)
    return {
      text: stringField(span.text, `${label}[${index}].text`),
      ...optional('bold', optionalBoolean(span.bold, `${label}[${index}].bold`)),
      ...optional('italic', optionalBoolean(span.italic, `${label}[${index}].italic`)),
      ...optional('underline', optionalBoolean(span.underline, `${label}[${index}].underline`)),
    }
  })
}

function textRows(value: unknown, label: string): string[][] {
  return array(value, label).map((row, r) => array(row, `${label}[${r}]`).map((each, c) => {
    if (typeof each === 'number' || typeof each === 'boolean') return String(each)
    return stringField(each, `${label}[${r}][${c}]`)
  }))
}

const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const

function docBlock(value: unknown, label: string): DocBlock {
  const input = record(value, label)
  switch (oneOf(input.type, ['heading', 'paragraph', 'list', 'table', 'pageBreak', 'chart'], `${label}.type`)) {
    case 'heading': {
      const level = HEADING_LEVELS.find(each => each === input.level)
      if (level === undefined) throw new ToolInputError(`${label}.level must be an integer from 1 to 6`)
      return { type: 'heading', level, text: stringField(input.text, `${label}.text`) }
    }
    case 'paragraph': {
      const align = input.align === undefined ? undefined : oneOf(input.align, ['left', 'center', 'right', 'justify'], `${label}.align`)
      return { type: 'paragraph', text: inline(input.text, `${label}.text`), ...(align ? { align } : {}) }
    }
    case 'list': return {
      type: 'list',
      items: array(input.items, `${label}.items`).map((each, index) => inline(each, `${label}.items[${index}]`)),
      ...optional('ordered', optionalBoolean(input.ordered, `${label}.ordered`)),
    }
    case 'table': return {
      type: 'table',
      rows: textRows(input.rows, `${label}.rows`),
      ...optional('header', optionalBoolean(input.header, `${label}.header`)),
    }
    case 'pageBreak': return { type: 'pageBreak' }
    case 'chart': return {
      type: 'chart',
      chart: chartSpec(input.chart, `${label}.chart`),
      ...optional('width', optionalNumber(input.width, `${label}.width`)),
      ...optional('height', optionalNumber(input.height, `${label}.height`)),
    }
  }
}

function pageSetup(value: unknown): PageSetup | undefined {
  if (value === undefined) return undefined
  const input = record(value, 'spec.page')
  return {
    ...optional('size', input.size === undefined ? undefined : oneOf(input.size, ['A4', 'Letter'], 'spec.page.size')),
    ...optional('orientation', input.orientation === undefined ? undefined : oneOf(input.orientation, ['portrait', 'landscape'], 'spec.page.orientation')),
    ...optional('margin', optionalNumber(input.margin, 'spec.page.margin')),
  }
}

export function documentSpec(value: unknown): DocumentSpec {
  const input = record(value, 'spec')
  return {
    ...optional('title', optionalString(input.title, 'spec.title')),
    ...optional('theme', theme(input.theme)),
    ...optional('page', pageSetup(input.page)),
    ...optional('header', optionalString(input.header, 'spec.header')),
    ...optional('footer', optionalString(input.footer, 'spec.footer')),
    ...optional('pageNumbers', optionalBoolean(input.pageNumbers, 'spec.pageNumbers')),
    blocks: array(input.blocks, 'spec.blocks').map((each, index) => docBlock(each, `spec.blocks[${index}]`)),
  }
}

// pptx

function slide(value: unknown, label: string): SlideSpec {
  const input = record(value, label)
  const table = input.table === undefined ? undefined : record(input.table, `${label}.table`)
  return {
    ...optional('title', optionalString(input.title, `${label}.title`)),
    ...optional('subtitle', optionalString(input.subtitle, `${label}.subtitle`)),
    ...optional('text', optionalString(input.text, `${label}.text`)),
    ...(input.bullets !== undefined
      ? { bullets: array(input.bullets, `${label}.bullets`).map((each, index) => stringField(each, `${label}.bullets[${index}]`)) }
      : {}),
    ...(table ? {
      table: {
        rows: textRows(table.rows, `${label}.table.rows`),
        ...optional('header', optionalBoolean(table.header, `${label}.table.header`)),
      },
    } : {}),
    ...(input.chart !== undefined ? { chart: chartSpec(input.chart, `${label}.chart`) } : {}),
    ...optional('notes', optionalString(input.notes, `${label}.notes`)),
  }
}

export function presentationSpec(value: unknown): PresentationSpec {
  const input = record(value, 'spec')
  const layout = input.layout === undefined ? undefined : oneOf(input.layout, ['16x9', '4x3'], 'spec.layout')
  return {
    ...optional('title', optionalString(input.title, 'spec.title')),
    ...(layout ? { layout } : {}),
    ...optional('theme', theme(input.theme)),
    ...optional('background', optionalString(input.background, 'spec.background')),
    ...optional('slideNumbers', optionalBoolean(input.slideNumbers, 'spec.slideNumbers')),
    slides: array(input.slides, 'spec.slides').map((each, index) => slide(each, `spec.slides[${index}]`)),
  }
}

// in-place edits of docx / pptx

function requiredNumber(value: unknown, label: string): number {
  const number = optionalNumber(value, label)
  if (number === undefined) throw new ToolInputError(`${label} must be a number`)
  return number
}

const DOCUMENT_OPS = ['replaceText', 'setParagraph', 'setCell', 'insert', 'delete'] as const

function documentOp(value: unknown, label: string): DocumentOp {
  const input = record(value, label)
  switch (oneOf(input.op, DOCUMENT_OPS, `${label}.op`)) {
    case 'replaceText': return {
      op: 'replaceText',
      find: stringField(input.find, `${label}.find`),
      replace: stringField(input.replace, `${label}.replace`),
      ...optional('matchCase', optionalBoolean(input.matchCase, `${label}.matchCase`)),
    }
    case 'setParagraph': return { op: 'setParagraph', index: requiredNumber(input.index, `${label}.index`), text: inline(input.text, `${label}.text`) }
    case 'setCell': return {
      op: 'setCell',
      index: requiredNumber(input.index, `${label}.index`),
      row: requiredNumber(input.row, `${label}.row`),
      column: requiredNumber(input.column, `${label}.column`),
      text: inline(input.text, `${label}.text`),
    }
    case 'insert': return {
      op: 'insert',
      ...optional('at', optionalNumber(input.at, `${label}.at`)),
      blocks: array(input.blocks, `${label}.blocks`).map((each, index) => docBlock(each, `${label}.blocks[${index}]`)),
    }
    case 'delete': return {
      op: 'delete',
      index: requiredNumber(input.index, `${label}.index`),
      ...optional('count', optionalNumber(input.count, `${label}.count`)),
    }
  }
}

export function documentOps(value: unknown): DocumentOp[] {
  const ops = array(value, 'ops')
  if (ops.length === 0) throw new ToolInputError('ops must not be empty')
  return ops.map((each, index) => documentOp(each, `ops[${index}]`))
}

const PRESENTATION_OPS = ['replaceText', 'setText', 'addSlides', 'deleteSlide', 'moveSlide'] as const

function presentationOp(value: unknown, label: string): PresentationOp {
  const input = record(value, label)
  switch (oneOf(input.op, PRESENTATION_OPS, `${label}.op`)) {
    case 'replaceText': return {
      op: 'replaceText',
      find: stringField(input.find, `${label}.find`),
      replace: stringField(input.replace, `${label}.replace`),
      ...optional('slide', optionalNumber(input.slide, `${label}.slide`)),
      ...optional('matchCase', optionalBoolean(input.matchCase, `${label}.matchCase`)),
    }
    case 'setText': return {
      op: 'setText',
      slide: requiredNumber(input.slide, `${label}.slide`),
      shape: stringField(input.shape, `${label}.shape`),
      text: typeof input.text === 'string' ? input.text : strings(input.text, `${label}.text`),
    }
    case 'addSlides': return {
      op: 'addSlides',
      ...optional('at', optionalNumber(input.at, `${label}.at`)),
      slides: array(input.slides, `${label}.slides`).map((each, index) => slide(each, `${label}.slides[${index}]`)),
      ...optional('theme', theme(input.theme, `${label}.theme`)),
    }
    case 'deleteSlide': return { op: 'deleteSlide', slide: requiredNumber(input.slide, `${label}.slide`) }
    case 'moveSlide': return { op: 'moveSlide', slide: requiredNumber(input.slide, `${label}.slide`), to: requiredNumber(input.to, `${label}.to`) }
  }
}

export function presentationOps(value: unknown): PresentationOp[] {
  const ops = array(value, 'ops')
  if (ops.length === 0) throw new ToolInputError('ops must not be empty')
  return ops.map((each, index) => presentationOp(each, `ops[${index}]`))
}
