import ExcelJS from 'exceljs'
import { formatRange, parseAddress, parseRange, type CellRange } from './address.js'
import { OfficeError } from './errors.js'
import { FormulaError, WorkbookEvaluator, displayValue } from './formula.js'
import { assertColor, assertTheme, type Theme } from './theme.js'
import { openPackage } from './ooxml.js'
import {
  assertSheetChart,
  chartReferences,
  outlineCharts,
  readCharts,
  renameInCharts,
  writeCharts,
  type CellReader,
  type SheetChartOutline,
  type SheetChartSpec,
} from './xlsx-chart.js'

/** 写入单元格的值：公式以 `=` 之外的对象形式给出，避免与以 `=` 开头的文本混淆。 */
export type CellInput = string | number | boolean | null | { formula: string }

/** 读出的单元格值：公式带上最近一次求值结果（文件里没有缓存结果时为 `null`）。 */
export type CellOutput = string | number | boolean | null | { formula: string, value: string | number | boolean | null }

export interface CellStyle {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  /** 字体名，例如 `Arial`。 */
  font?: string
  /** 字号（磅）。 */
  size?: number
  /** 文字颜色，6 位十六进制 RGB。 */
  color?: string
  /** Excel 数字格式，例如 `0.00%`、`#,##0`、`yyyy-mm-dd`。 */
  numFmt?: string
  /** 背景色，6 位十六进制 RGB，例如 `FFF2CC`。 */
  fill?: string
  align?: 'left' | 'center' | 'right'
  valign?: 'top' | 'middle' | 'bottom'
  wrap?: boolean
  /** 区域内每个单元格四边的边框；`none` 清除边框。 */
  border?: 'thin' | 'medium' | 'thick' | 'none'
  /** 边框颜色，缺省为浅灰。 */
  borderColor?: string
}

export interface RangeStyle {
  range: string
  style: CellStyle
}

export interface SheetSpec {
  name: string
  /** 从 A1 开始逐行写入。 */
  rows?: CellInput[][]
  /** 从 A 列开始的列宽（字符数）。 */
  columnWidths?: number[]
  /** 冻结首若干行/列，常用于表头。 */
  freeze?: { rows?: number, columns?: number }
  styles?: RangeStyle[]
  /** 合并的区域，例如 `A1:E1`。 */
  merges?: string[]
  /** 从第 1 行开始的行高（磅）。 */
  rowHeights?: number[]
  /** 给表头加筛选按钮的区域，例如 `A1:E1`。 */
  autoFilter?: string
  /** 原生 Excel 图表，系列引用本表（或其它表）的单元格区域。 */
  charts?: SheetChartSpec[]
}

export interface WorkbookSpec {
  /** 字体用于所有写入的单元格；强调色用于图表。 */
  theme?: Theme
  sheets: SheetSpec[]
}

export type WorkbookOp =
  | { op: 'setCells', sheet: string, start: string, rows: CellInput[][] }
  | { op: 'clear', sheet: string, range: string }
  | { op: 'style', sheet: string, range: string, style: CellStyle }
  | { op: 'setColumnWidths', sheet: string, start?: string, widths: number[] }
  | { op: 'setRowHeights', sheet: string, start?: number, heights: number[] }
  | { op: 'merge', sheet: string, range: string }
  | { op: 'unmerge', sheet: string, range: string }
  | { op: 'autoFilter', sheet: string, range: string | null }
  | { op: 'addChart', sheet: string, chart: SheetChartSpec }
  | { op: 'removeChart', sheet: string, index: number }
  | { op: 'addSheet', name: string }
  | { op: 'renameSheet', sheet: string, name: string }
  | { op: 'deleteSheet', sheet: string }

export interface SheetOutline {
  name: string
  /** 已用区域，空 sheet 为 `null`。 */
  range: string | null
  rows: number
  columns: number
  formulas: number
  /** 首行，通常是表头。 */
  header: CellOutput[]
  charts: SheetChartOutline[]
}

export interface WorkbookOutline {
  sheets: SheetOutline[]
}

export interface ReadRangeRequest {
  /** 缺省读第一个 sheet。 */
  sheet?: string
  /** 缺省读已用区域。 */
  range?: string
  /** 单次最多返回的单元格数，超出时按整行截断。 */
  maxCells?: number
}

export interface RangeRead {
  sheet: string
  range: string | null
  rows: CellOutput[][]
  truncated: boolean
}

export const DEFAULT_MAX_CELLS = 2_000

async function load(bytes: Uint8Array): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook()
  try {
    // exceljs 声明了自己的 `Buffer`（即 ArrayBuffer），复制一份独立的 ArrayBuffer 传入。
    await workbook.xlsx.load(bytes.slice().buffer)
  } catch (error) {
    throw new OfficeError('not a readable xlsx workbook', 'OFFICE_INVALID', { cause: error })
  }
  return workbook
}

/** 读取已求值工作簿的单元格，供图表缓存与大纲使用。 */
function cellReader(workbook: ExcelJS.Workbook): CellReader {
  const evaluator = new WorkbookEvaluator(workbook)
  return (sheetName, row, column) => {
    const sheet = workbook.getWorksheet(sheetName)
    if (!sheet) return null
    const value = readCell(sheet.getCell(row, column), evaluator)
    return value !== null && typeof value === 'object' ? value.value : value
  }
}

type ChartMap = Map<string, SheetChartSpec[]>

async function save(workbook: ExcelJS.Workbook, charts: ChartMap = new Map(), theme?: Theme): Promise<Uint8Array> {
  const bytes = await saveCells(workbook)
  if (![...charts.values()].some(list => list.length > 0)) return bytes
  // exceljs 写不了图表：在它保存好的包里补上图表部件。
  const zip = await openPackage(bytes, 'xlsx')
  await writeCharts(zip, charts, cellReader(workbook), theme)
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

async function saveCells(workbook: ExcelJS.Workbook): Promise<Uint8Array> {
  refreshResults(workbook)
  // 我们的求值是近似的；让 Excel 打开时重算，以它的结果为准。
  workbook.calcProperties.fullCalcOnLoad = true
  return new Uint8Array(await workbook.xlsx.writeBuffer())
}

function sheetNamed(workbook: ExcelJS.Workbook, name: string): ExcelJS.Worksheet {
  const sheet = workbook.getWorksheet(name)
  if (!sheet) {
    const names = workbook.worksheets.map(each => each.name).join(', ')
    throw new OfficeError(`no sheet named "${name}" (sheets: ${names})`, 'OFFICE_INVALID')
  }
  return sheet
}

function addSheet(workbook: ExcelJS.Workbook, name: string): ExcelJS.Worksheet {
  if (workbook.getWorksheet(name)) throw new OfficeError(`sheet already exists: ${name}`, 'OFFICE_INVALID')
  try {
    return workbook.addWorksheet(name)
  } catch (error) {
    throw new OfficeError(`invalid sheet name: ${name}`, 'OFFICE_INVALID', { cause: error })
  }
}

function toCellValue(input: CellInput): ExcelJS.CellValue {
  if (input === null || typeof input !== 'object') return input
  if (typeof input.formula !== 'string' || input.formula.trim() === '') {
    throw new OfficeError('formula cells need a non-empty formula string', 'OFFICE_INVALID')
  }
  return { formula: input.formula.replace(/^=/, '') }
}

function scalar(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    if ('error' in value && typeof value.error === 'string') return value.error
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map(part => (part && typeof part === 'object' && 'text' in part ? String(part.text) : '')).join('')
    }
    if ('text' in value && typeof value.text === 'string') return value.text
    if ('result' in value) return scalar(value.result)
  }
  return String(value)
}

function cachedResult(cell: ExcelJS.Cell): unknown {
  const value = cell.value
  return value && typeof value === 'object' && 'result' in value ? value.result : undefined
}

/** 公式格优先用文件里缓存的结果（Excel 算的更可信），没有缓存时由求值器补上。 */
function readCell(cell: ExcelJS.Cell, evaluator: WorkbookEvaluator): CellOutput {
  const formula = cell.formula
  if (formula) {
    const result = cachedResult(cell)
    const value = result === undefined
      ? displayValue(evaluator.cell(cell.worksheet.name, Number(cell.row), Number(cell.col)))
      : scalar(result)
    return { formula, value }
  }
  return scalar(cell.value)
}

/**
 * 重算所有公式并把结果写回缓存，使不做计算的读者（预览器、其它库）也能看到数值。
 * 求值失败的格清掉缓存结果，留给 Excel 打开时重算，而不是保留可能过期的旧值。
 */
function refreshResults(workbook: ExcelJS.Workbook): void {
  const evaluator = new WorkbookEvaluator(workbook)
  for (const sheet of workbook.worksheets) {
    sheet.eachRow(row => row.eachCell(cell => {
      const value = cell.value
      if (!cell.formula || !value || typeof value !== 'object') return
      const result = evaluator.cell(sheet.name, Number(cell.row), Number(cell.col))
      const cached = result instanceof FormulaError ? {} : { result: result ?? 0 }
      if ('sharedFormula' in value) cell.value = { sharedFormula: value.sharedFormula, ...cached }
      else if ('formula' in value) cell.value = { formula: value.formula, ...cached }
    }))
  }
}

function usedRange(sheet: ExcelJS.Worksheet): CellRange | undefined {
  if (sheet.actualRowCount === 0) return undefined
  return { start: { row: 1, column: 1 }, end: { row: sheet.rowCount, column: sheet.columnCount } }
}

function writeRows(sheet: ExcelJS.Worksheet, start: string, rows: CellInput[][]): void {
  const origin = parseAddress(start)
  rows.forEach((row, r) => {
    row.forEach((input, c) => {
      sheet.getCell(origin.row + r, origin.column + c).value = toCellValue(input)
    })
  })
}

function argb(color: string): string {
  return `FF${color.toUpperCase()}`
}

function applyStyle(sheet: ExcelJS.Worksheet, range: string, style: CellStyle): void {
  const { start, end } = parseRange(range)
  assertColor(style.fill, 'fill')
  assertColor(style.color, 'color')
  assertColor(style.borderColor, 'borderColor')
  if (style.size !== undefined && !(style.size > 0 && style.size <= 409)) {
    throw new OfficeError(`font size must be between 1 and 409: ${style.size}`, 'OFFICE_INVALID')
  }
  const font: Partial<ExcelJS.Font> = {
    ...(style.bold !== undefined ? { bold: style.bold } : {}),
    ...(style.italic !== undefined ? { italic: style.italic } : {}),
    ...(style.underline !== undefined ? { underline: style.underline } : {}),
    ...(style.font !== undefined ? { name: style.font } : {}),
    ...(style.size !== undefined ? { size: style.size } : {}),
    ...(style.color !== undefined ? { color: { argb: argb(style.color) } } : {}),
  }
  const alignment: Partial<ExcelJS.Alignment> = {
    ...(style.align !== undefined ? { horizontal: style.align } : {}),
    ...(style.valign !== undefined ? { vertical: style.valign } : {}),
    ...(style.wrap !== undefined ? { wrapText: style.wrap } : {}),
  }
  const edge: Partial<ExcelJS.Border> | undefined = style.border === undefined || style.border === 'none'
    ? undefined
    : { style: style.border, color: { argb: argb(style.borderColor ?? 'BFBFBF') } }
  for (let row = start.row; row <= end.row; row++) {
    for (let column = start.column; column <= end.column; column++) {
      const cell = sheet.getCell(row, column)
      if (Object.keys(font).length > 0) cell.font = { ...cell.font, ...font }
      if (Object.keys(alignment).length > 0) cell.alignment = { ...cell.alignment, ...alignment }
      if (style.numFmt !== undefined) cell.numFmt = style.numFmt
      if (style.fill !== undefined) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(style.fill) } }
      if (style.border === 'none') cell.border = {}
      else if (edge) cell.border = { top: edge, left: edge, bottom: edge, right: edge }
    }
  }
}

function setRowHeights(sheet: ExcelJS.Worksheet, start: number, heights: number[]): void {
  if (!Number.isInteger(start) || start < 1) throw new OfficeError(`invalid start row: ${start}`, 'OFFICE_INVALID')
  heights.forEach((height, index) => {
    if (!Number.isFinite(height) || height <= 0) throw new OfficeError(`invalid row height: ${height}`, 'OFFICE_INVALID')
    sheet.getRow(start + index).height = height
  })
}

function merge(sheet: ExcelJS.Worksheet, range: string): void {
  const normalized = formatRange(parseRange(range))
  try {
    sheet.mergeCells(normalized)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new OfficeError(`cannot merge ${range}: ${reason}`, 'OFFICE_INVALID', { cause: error })
  }
}

/** 主题字体落到所有已写入的单元格上；显式设置过字体的单元格保持不变。 */
function applyThemeFont(sheet: ExcelJS.Worksheet, font: string): void {
  sheet.eachRow(row => row.eachCell(cell => {
    if (!cell.font?.name) cell.font = { ...cell.font, name: font }
  }))
}

function setColumnWidths(sheet: ExcelJS.Worksheet, start: string, widths: number[]): void {
  const first = parseAddress(`${start}1`).column
  widths.forEach((width, index) => {
    if (!Number.isFinite(width) || width <= 0) throw new OfficeError(`invalid column width: ${width}`, 'OFFICE_INVALID')
    sheet.getColumn(first + index).width = width
  })
}

export async function createWorkbook(spec: WorkbookSpec): Promise<Uint8Array> {
  if (!spec.sheets?.length) throw new OfficeError('a workbook needs at least one sheet', 'OFFICE_INVALID')
  assertTheme(spec.theme)
  const charts: ChartMap = new Map()
  for (const sheetSpec of spec.sheets) {
    sheetSpec.charts?.forEach((chart, index) => assertSheetChart(chart, sheetSpec.name, `sheets[${sheetSpec.name}].charts[${index}]`))
    if (sheetSpec.charts?.length) charts.set(sheetSpec.name, [...sheetSpec.charts])
  }
  const workbook = new ExcelJS.Workbook()
  for (const sheetSpec of spec.sheets) {
    const sheet = addSheet(workbook, sheetSpec.name)
    if (sheetSpec.rows) writeRows(sheet, 'A1', sheetSpec.rows)
    if (sheetSpec.columnWidths) setColumnWidths(sheet, 'A', sheetSpec.columnWidths)
    for (const { range, style } of sheetSpec.styles ?? []) applyStyle(sheet, range, style)
    for (const range of sheetSpec.merges ?? []) merge(sheet, range)
    if (sheetSpec.rowHeights) setRowHeights(sheet, 1, sheetSpec.rowHeights)
    if (sheetSpec.autoFilter) sheet.autoFilter = formatRange(parseRange(sheetSpec.autoFilter))
    if (spec.theme?.font) applyThemeFont(sheet, spec.theme.font)
    const freeze = sheetSpec.freeze
    if (freeze && (freeze.rows || freeze.columns)) {
      sheet.views = [{ state: 'frozen', xSplit: freeze.columns ?? 0, ySplit: freeze.rows ?? 0 }]
    }
  }
  return save(workbook, charts, spec.theme)
}

/** 读出文件里的图表；遇到无法如实重建的图表时拒绝，避免编辑时把它悄悄丢掉。 */
async function existingCharts(bytes: Uint8Array): Promise<ChartMap> {
  const charts: ChartMap = new Map()
  for (const found of await readCharts(await openPackage(bytes, 'xlsx'))) {
    if (!found.supported || !found.spec) {
      throw new OfficeError(`sheet "${found.sheet}" has ${found.reason ?? 'a chart this tool cannot rebuild'}; editing would drop it`, 'OFFICE_UNSUPPORTED')
    }
    charts.set(found.sheet, [...(charts.get(found.sheet) ?? []), found.spec])
  }
  return charts
}

export async function inspectWorkbook(bytes: Uint8Array): Promise<WorkbookOutline> {
  const workbook = await load(bytes)
  const evaluator = new WorkbookEvaluator(workbook)
  const read = cellReader(workbook)
  const found = await readCharts(await openPackage(bytes, 'xlsx'))
  return {
    sheets: workbook.worksheets.map(sheet => {
      const range = usedRange(sheet)
      let formulas = 0
      sheet.eachRow(row => row.eachCell(cell => { if (cell.formula) formulas++ }))
      const header: CellOutput[] = []
      if (range) {
        for (let column = 1; column <= range.end.column; column++) header.push(readCell(sheet.getCell(1, column), evaluator))
      }
      return {
        name: sheet.name,
        range: range ? formatRange(range) : null,
        rows: range?.end.row ?? 0,
        columns: range?.end.column ?? 0,
        formulas,
        header,
        charts: outlineCharts(sheet.name, found.flatMap(chart => (chart.sheet === sheet.name && chart.spec ? [chart.spec] : [])), read),
      }
    }),
  }
}

export async function readRange(bytes: Uint8Array, request: ReadRangeRequest = {}): Promise<RangeRead> {
  const workbook = await load(bytes)
  const evaluator = new WorkbookEvaluator(workbook)
  const sheet = request.sheet === undefined ? workbook.worksheets[0] : sheetNamed(workbook, request.sheet)
  if (!sheet) throw new OfficeError('workbook has no sheets', 'OFFICE_INVALID')
  const range = request.range === undefined ? usedRange(sheet) : parseRange(request.range)
  if (!range) return { sheet: sheet.name, range: null, rows: [], truncated: false }

  const maxCells = request.maxCells ?? DEFAULT_MAX_CELLS
  const width = range.end.column - range.start.column + 1
  const maxRows = Math.max(1, Math.floor(maxCells / width))
  const lastRow = Math.min(range.end.row, range.start.row + maxRows - 1)
  const rows: CellOutput[][] = []
  for (let row = range.start.row; row <= lastRow; row++) {
    const values: CellOutput[] = []
    for (let column = range.start.column; column <= range.end.column; column++) {
      values.push(readCell(sheet.getCell(row, column), evaluator))
    }
    rows.push(values)
  }
  return {
    sheet: sheet.name,
    range: formatRange({ start: range.start, end: { row: lastRow, column: range.end.column } }),
    rows,
    truncated: lastRow < range.end.row,
  }
}

/** 按顺序应用一批修改；任何一步失败都不产出文件，调用方的原文件保持不变。 */
export async function editWorkbook(bytes: Uint8Array, ops: readonly WorkbookOp[]): Promise<Uint8Array> {
  const charts = await existingCharts(bytes)
  const workbook = await load(bytes)
  for (const op of ops) {
    switch (op.op) {
      case 'setCells':
        writeRows(sheetNamed(workbook, op.sheet), op.start, op.rows)
        break
      case 'clear': {
        const sheet = sheetNamed(workbook, op.sheet)
        const { start, end } = parseRange(op.range)
        for (let row = start.row; row <= end.row; row++) {
          for (let column = start.column; column <= end.column; column++) sheet.getCell(row, column).value = null
        }
        break
      }
      case 'style':
        applyStyle(sheetNamed(workbook, op.sheet), op.range, op.style)
        break
      case 'setColumnWidths':
        setColumnWidths(sheetNamed(workbook, op.sheet), op.start ?? 'A', op.widths)
        break
      case 'setRowHeights':
        setRowHeights(sheetNamed(workbook, op.sheet), op.start ?? 1, op.heights)
        break
      case 'merge':
        merge(sheetNamed(workbook, op.sheet), op.range)
        break
      case 'unmerge':
        sheetNamed(workbook, op.sheet).unMergeCells(formatRange(parseRange(op.range)))
        break
      case 'autoFilter': {
        const sheet = sheetNamed(workbook, op.sheet)
        if (op.range === null) delete sheet.autoFilter
        else sheet.autoFilter = formatRange(parseRange(op.range))
        break
      }
      case 'addSheet':
        addSheet(workbook, op.name)
        break
      case 'renameSheet': {
        const sheet = sheetNamed(workbook, op.sheet)
        if (workbook.getWorksheet(op.name)) throw new OfficeError(`sheet already exists: ${op.name}`, 'OFFICE_INVALID')
        sheet.name = op.name
        for (const [chartSheet, specs] of [...charts]) {
          charts.delete(chartSheet)
          charts.set(chartSheet === op.sheet ? op.name : chartSheet, renameInCharts(specs, chartSheet, op.sheet, op.name))
        }
        break
      }
      case 'deleteSheet': {
        const sheet = sheetNamed(workbook, op.sheet)
        if (workbook.worksheets.length === 1) throw new OfficeError('cannot delete the only sheet', 'OFFICE_INVALID')
        charts.delete(op.sheet)
        for (const [chartSheet, specs] of charts) {
          if (specs.some(spec => chartReferences(spec, chartSheet, op.sheet))) {
            throw new OfficeError(`a chart on "${chartSheet}" uses data from "${op.sheet}"; remove it first`, 'OFFICE_INVALID')
          }
        }
        workbook.removeWorksheet(sheet.id)
        break
      }
      case 'addChart': {
        sheetNamed(workbook, op.sheet)
        const list = charts.get(op.sheet) ?? []
        assertSheetChart(op.chart, op.sheet, `charts[${list.length}]`)
        charts.set(op.sheet, [...list, op.chart])
        break
      }
      case 'removeChart': {
        const list = charts.get(op.sheet) ?? []
        if (!Number.isInteger(op.index) || op.index < 0 || op.index >= list.length) {
          throw new OfficeError(`sheet "${op.sheet}" has no chart #${op.index} (charts: ${list.length})`, 'OFFICE_INVALID')
        }
        charts.set(op.sheet, list.filter((_, index) => index !== op.index))
        break
      }
      default: {
        const unknown: never = op
        throw new OfficeError(`unknown workbook op: ${JSON.stringify(unknown)}`, 'OFFICE_INVALID')
      }
    }
  }
  return save(workbook, charts)
}
