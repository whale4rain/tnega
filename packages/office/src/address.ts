import { OfficeError } from './errors.js'

/** 1 起始的行列坐标。 */
export interface CellPosition {
  row: number
  column: number
}

export interface CellRange {
  start: CellPosition
  end: CellPosition
}

/** Excel 允许的最大行列，超出即视为非法地址。 */
const MAX_ROWS = 1_048_576
const MAX_COLUMNS = 16_384

export function columnName(column: number): string {
  let name = ''
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name
  }
  return name
}

export function columnNumber(name: string): number {
  if (!/^[A-Za-z]{1,3}$/.test(name)) throw new OfficeError(`invalid column: ${name}`, 'OFFICE_INVALID')
  let column = 0
  for (const char of name.toUpperCase()) column = column * 26 + char.charCodeAt(0) - 64
  if (column > MAX_COLUMNS) throw new OfficeError(`column out of range: ${name}`, 'OFFICE_INVALID')
  return column
}

export function formatAddress(position: CellPosition): string {
  return `${columnName(position.column)}${position.row}`
}

export function parseAddress(address: string): CellPosition {
  const match = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(address.trim())
  if (!match) throw new OfficeError(`invalid cell address: ${address}`, 'OFFICE_INVALID')
  const row = Number(match[2])
  if (row < 1 || row > MAX_ROWS) throw new OfficeError(`row out of range: ${address}`, 'OFFICE_INVALID')
  return { row, column: columnNumber(match[1] ?? '') }
}

/** 解析 `A1:C3` 或单格 `B2`；起止顺序无关，结果总是左上到右下。 */
export function parseRange(range: string): CellRange {
  const [first, second, ...rest] = range.split(':')
  if (first === undefined || rest.length > 0) throw new OfficeError(`invalid range: ${range}`, 'OFFICE_INVALID')
  const a = parseAddress(first)
  const b = second === undefined ? a : parseAddress(second)
  return {
    start: { row: Math.min(a.row, b.row), column: Math.min(a.column, b.column) },
    end: { row: Math.max(a.row, b.row), column: Math.max(a.column, b.column) },
  }
}

export function formatRange(range: CellRange): string {
  const start = formatAddress(range.start)
  const end = formatAddress(range.end)
  return start === end ? start : `${start}:${end}`
}
