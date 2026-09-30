import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import {
  OfficeError,
  columnName,
  createWorkbook,
  editWorkbook,
  inspectWorkbook,
  parseRange,
  readRange,
} from '../src/index.js'

const sales = {
  sheets: [{
    name: 'Sales',
    rows: [
      ['Region', 'Q1', 'Q2', 'Total'],
      ['North', 120, 80, { formula: 'SUM(B2:C2)' }],
      ['South', 90, 110, { formula: '=SUM(B3:C3)' }],
    ],
    columnWidths: [14, 10, 10, 12],
    freeze: { rows: 1 },
    styles: [{ range: 'A1:D1', style: { bold: true, fill: 'FFF2CC' } }],
  }],
}

async function reopen(bytes: Uint8Array): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(bytes.slice().buffer)
  return workbook
}

describe('addresses', () => {
  it('round-trips column names and normalizes ranges', () => {
    expect(columnName(1)).toBe('A')
    expect(columnName(28)).toBe('AB')
    expect(parseRange('C3:A1')).toEqual({ start: { row: 1, column: 1 }, end: { row: 3, column: 3 } })
    expect(() => parseRange('1A')).toThrow(OfficeError)
  })
})

describe('xlsx', () => {
  it('creates a workbook that Excel libraries reopen with formulas and styles', async () => {
    const workbook = await reopen(await createWorkbook(sales))
    const sheet = workbook.getWorksheet('Sales')
    expect(sheet?.getCell('D2').formula).toBe('SUM(B2:C2)')
    expect(sheet?.getCell('D3').formula).toBe('SUM(B3:C3)')
    expect(sheet?.getCell('A1').font.bold).toBe(true)
    expect(sheet?.getColumn(1).width).toBe(14)
    expect(sheet?.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 })
  })

  it('outlines sheets with used range, header and formula count', async () => {
    const outline = await inspectWorkbook(await createWorkbook(sales))
    expect(outline.sheets).toEqual([{
      name: 'Sales',
      range: 'A1:D3',
      rows: 3,
      columns: 4,
      formulas: 2,
      header: ['Region', 'Q1', 'Q2', 'Total'],
    }])
  })

  it('reads a range and truncates by whole rows', async () => {
    const bytes = await createWorkbook(sales)
    expect(await readRange(bytes, { range: 'A2:B3' })).toEqual({
      sheet: 'Sales', range: 'A2:B3', rows: [['North', 120], ['South', 90]], truncated: false,
    })
    const partial = await readRange(bytes, { maxCells: 8 })
    expect(partial.range).toBe('A1:D2')
    expect(partial.truncated).toBe(true)
    expect(partial.rows[1]?.[3]).toEqual({ formula: 'SUM(B2:C2)', value: null })
  })

  it('applies a batch of edits in order', async () => {
    const edited = await editWorkbook(await createWorkbook(sales), [
      { op: 'setCells', sheet: 'Sales', start: 'A4', rows: [['Total', { formula: 'SUM(B2:B3)' }]] },
      { op: 'style', sheet: 'Sales', range: 'B2:D4', style: { numFmt: '#,##0' } },
      { op: 'addSheet', name: 'Notes' },
      { op: 'setCells', sheet: 'Notes', start: 'A1', rows: [['Source: CRM export']] },
      { op: 'renameSheet', sheet: 'Sales', name: 'Revenue' },
      { op: 'clear', sheet: 'Revenue', range: 'C3' },
    ])
    const outline = await inspectWorkbook(edited)
    expect(outline.sheets.map(sheet => sheet.name)).toEqual(['Revenue', 'Notes'])
    const read = await readRange(edited, { sheet: 'Revenue', range: 'A3:C4' })
    expect(read.rows).toEqual([['South', 90, null], ['Total', { formula: 'SUM(B2:B3)', value: null }, null]])
    const workbook = await reopen(edited)
    expect(workbook.getWorksheet('Revenue')?.getCell('B4').numFmt).toBe('#,##0')
  })

  it('rejects invalid edits without producing a file', async () => {
    const bytes = await createWorkbook(sales)
    await expect(editWorkbook(bytes, [{ op: 'setCells', sheet: 'Missing', start: 'A1', rows: [[1]] }]))
      .rejects.toMatchObject({ code: 'OFFICE_INVALID', message: expect.stringContaining('sheets: Sales') })
    await expect(editWorkbook(bytes, [{ op: 'deleteSheet', sheet: 'Sales' }]))
      .rejects.toThrow('only sheet')
    await expect(editWorkbook(bytes, [{ op: 'style', sheet: 'Sales', range: 'A1', style: { fill: 'red' } }]))
      .rejects.toThrow('hex color')
    await expect(readRange(new TextEncoder().encode('not a zip'))).rejects.toMatchObject({ code: 'OFFICE_INVALID' })
  })
})
