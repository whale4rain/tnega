import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { formatNumber, formatValue, sheetView } from './xlsx-view'

describe('formatNumber', () => {
  it('approximates common Excel number formats', () => {
    expect(formatNumber(1234.5)).toBe('1234.5')
    expect(formatNumber(0.1 + 0.2)).toBe('0.3')
    expect(formatNumber(1234.567, '#,##0.00')).toBe('1,234.57')
    expect(formatNumber(1234.567, '0')).toBe('1235')
    expect(formatNumber(0.1234, '0.0%')).toBe('12.3%')
    expect(formatNumber(-1500, '"$"#,##0')).toBe('-$1,500')
    expect(formatNumber(99.5, '$#,##0.00')).toBe('$99.50')
    expect(formatNumber(-3, '#,##0;(#,##0)')).toBe('(3)')
    expect(formatNumber(3, '#,##0;(#,##0)')).toBe('3')
    expect(formatNumber(45292, 'yyyy-mm-dd')).toBe('2024-01-01')
  })
})

describe('formatValue', () => {
  it('shows formula results, rich text, errors and booleans', () => {
    expect(formatValue({ formula: 'A1*2', result: 0.5 }, '0%')).toBe('50%')
    expect(formatValue({ formula: 'A1*2' })).toBe('')
    expect(formatValue({ richText: [{ text: 'a' }, { text: 'b' }] })).toBe('ab')
    expect(formatValue({ error: '#DIV/0!' })).toBe('#DIV/0!')
    expect(formatValue(true)).toBe('TRUE')
    expect(formatValue(new Date(Date.UTC(2024, 0, 2)))).toBe('2024-01-02')
  })
})

describe('sheetView', () => {
  it('builds a styled grid with column widths', () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Sales')
    sheet.addRow(['Region', 'Total'])
    sheet.addRow(['North', { formula: 'B3*2', result: 1200 }])
    sheet.getCell('A1').font = { bold: true }
    sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } }
    sheet.getCell('B2').numFmt = '#,##0'
    sheet.getColumn(1).width = 20
    const view = sheetView(sheet)
    expect(view.name).toBe('Sales')
    expect(view.widths).toEqual([145, 72])
    expect(view.rows[0]?.[0]).toEqual({ text: 'Region', numeric: false, bold: true, fill: '#FFF2CC' })
    expect(view.rows[1]?.[1]).toEqual({ text: '1,200', numeric: true })
    expect(view.truncated).toBe(false)
  })
})
