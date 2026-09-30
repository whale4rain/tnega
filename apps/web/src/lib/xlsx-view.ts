import type { Cell, Worksheet } from 'exceljs'

/** A read-only grid for previewing one worksheet: text is already formatted for display. */
export interface GridCell {
  text: string
  numeric: boolean
  bold?: boolean
  italic?: boolean
  /** CSS color, e.g. `#FFF2CC`. */
  fill?: string
  align?: 'left' | 'center' | 'right'
}

export interface SheetView {
  name: string
  rows: GridCell[][]
  /** Column widths in pixels. */
  widths: number[]
  truncated: boolean
}

export const MAX_PREVIEW_ROWS = 500
export const MAX_PREVIEW_COLUMNS = 50

const EXCEL_EPOCH = Date.UTC(1899, 11, 30)
const DEFAULT_WIDTH = 72

function decimals(format: string): number {
  const match = /\.(0+)/.exec(format)
  return match?.[1]?.length ?? 0
}

function isDateFormat(format: string): boolean {
  // Strip quoted literals and bracketed colors/locales before looking for date tokens.
  const bare = format.replace(/"[^"]*"|\[[^\]]*\]/g, '')
  return /[dy]/i.test(bare) || /h+:m/i.test(bare)
}

function formatDate(date: Date): string {
  const iso = date.toISOString()
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 16).replace('T', ' ')
}

/** Format a number the way its Excel number format roughly would; unknown formats fall back to General. */
export function formatNumber(value: number, format?: string): string {
  if (!format || format === 'General') return String(Math.round(value * 1e10) / 1e10)
  const section = format.split(';')[value < 0 && format.includes(';') ? 1 : 0] ?? format
  const signed = value < 0 && format.includes(';') ? Math.abs(value) : value
  if (isDateFormat(section)) return formatDate(new Date(EXCEL_EPOCH + value * 86_400_000))
  const digits = decimals(section)
  const prefix = /^(?:"([^"]*)"|([$€£¥]))/.exec(section.replace(/^\[[^\]]*\]/, ''))
  const symbol = prefix?.[1] ?? prefix?.[2] ?? ''
  if (section.includes('%')) return `${(signed * 100).toFixed(digits)}%`
  const text = Math.abs(signed).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: section.includes(','),
  })
  const body = `${signed < 0 ? '-' : ''}${symbol}${text}`
  // Accounting-style negative sections wrap the number in parentheses.
  return /\(.*[#0].*\)/.test(section) ? `(${body})` : body
}

/** The displayed text of any exceljs cell value; formulas show their cached result. */
export function formatValue(value: unknown, format?: string): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return formatNumber(value, format)
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (typeof value === 'string') return value
  if (value instanceof Date) return formatDate(value)
  if (typeof value === 'object') {
    if ('result' in value) return formatValue(value.result, format)
    if ('formula' in value || 'sharedFormula' in value) return ''
    if ('error' in value && typeof value.error === 'string') return value.error
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map(part => (part && typeof part === 'object' && 'text' in part ? String(part.text) : '')).join('')
    }
    if ('text' in value && typeof value.text === 'string') return value.text
  }
  return String(value)
}

function isNumeric(value: unknown): boolean {
  if (typeof value === 'number' || value instanceof Date) return true
  return Boolean(value && typeof value === 'object' && 'result' in value && typeof value.result === 'number')
}

function fillColor(cell: Cell): string | undefined {
  const fill = cell.fill
  if (fill?.type !== 'pattern' || fill.pattern !== 'solid') return undefined
  const argb = fill.fgColor?.argb
  return argb && /^[0-9A-Fa-f]{8}$/.test(argb) ? `#${argb.slice(2)}` : undefined
}

function gridCell(cell: Cell): GridCell {
  const value = cell.value
  const horizontal = cell.alignment?.horizontal
  const fill = fillColor(cell)
  return {
    text: formatValue(value, cell.numFmt),
    numeric: isNumeric(value),
    ...(cell.font?.bold ? { bold: true } : {}),
    ...(cell.font?.italic ? { italic: true } : {}),
    ...(fill ? { fill } : {}),
    ...(horizontal === 'left' || horizontal === 'center' || horizontal === 'right' ? { align: horizontal } : {}),
  }
}

export function sheetView(sheet: Worksheet): SheetView {
  const rowCount = Math.min(sheet.rowCount, MAX_PREVIEW_ROWS)
  const columnCount = Math.min(sheet.columnCount, MAX_PREVIEW_COLUMNS)
  const rows: GridCell[][] = []
  for (let row = 1; row <= rowCount; row++) {
    const cells: GridCell[] = []
    for (let column = 1; column <= columnCount; column++) cells.push(gridCell(sheet.getCell(row, column)))
    rows.push(cells)
  }
  const widths = Array.from({ length: columnCount }, (_, index) => {
    const width = sheet.getColumn(index + 1).width
    return width ? Math.round(width * 7 + 5) : DEFAULT_WIDTH
  })
  return {
    name: sheet.name,
    rows,
    widths,
    truncated: sheet.rowCount > rowCount || sheet.columnCount > columnCount,
  }
}
