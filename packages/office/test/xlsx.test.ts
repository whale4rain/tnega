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
    expect(partial.rows[1]?.[3]).toEqual({ formula: 'SUM(B2:C2)', value: 200 })
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
    expect(read.rows).toEqual([['South', 90, null], ['Total', { formula: 'SUM(B2:B3)', value: 210 }, null]])
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

describe('xlsx deleteSheet', () => {
  it('reports a missing sheet before the only-sheet rule', async () => {
    await expect(editWorkbook(await createWorkbook(sales), [{ op: 'deleteSheet', sheet: 'Missing' }]))
      .rejects.toThrow('no sheet named "Missing"')
  })
})

describe('xlsx styling', () => {
  it('applies fonts, colors, borders, wrapping, merges, row heights, filters and a theme font', async () => {
    const bytes = await createWorkbook({
      theme: { font: 'Arial', accent: '1F4E79' },
      sheets: [{
        name: 'Report',
        rows: [['Q2 Report', null, null], ['Region', 'Total', 'Note'], ['North', 200, 'long text that wraps']],
        merges: ['A1:C1'],
        rowHeights: [28],
        autoFilter: 'A2:C2',
        styles: [
          { range: 'A1', style: { size: 16, bold: true, color: '1F4E79', align: 'center', valign: 'middle' } },
          { range: 'A2:C3', style: { border: 'thin', borderColor: '999999' } },
          { range: 'C3', style: { wrap: true, font: 'Georgia', underline: true } },
        ],
      }],
    })
    const workbook = await reopen(bytes)
    const sheet = workbook.getWorksheet('Report')
    expect(sheet?.getCell('A1').font).toMatchObject({ size: 16, bold: true, name: 'Arial', color: { argb: 'FF1F4E79' } })
    expect(sheet?.getCell('A1').alignment).toMatchObject({ horizontal: 'center', vertical: 'middle' })
    expect(sheet?.getCell('C1').isMerged).toBe(true)
    expect(sheet?.getRow(1).height).toBe(28)
    expect(sheet?.autoFilter).toBe('A2:C2')
    expect(sheet?.getCell('B3').border.bottom).toMatchObject({ style: 'thin', color: { argb: 'FF999999' } })
    expect(sheet?.getCell('C3').font).toMatchObject({ name: 'Georgia', underline: true })
    expect(sheet?.getCell('C3').alignment.wrapText).toBe(true)
    expect(sheet?.getCell('B2').font.name).toBe('Arial')
  })

  it('edits merges, row heights, filters and borders', async () => {
    const edited = await editWorkbook(await createWorkbook(sales), [
      { op: 'merge', sheet: 'Sales', range: 'A5:D5' },
      { op: 'setRowHeights', sheet: 'Sales', start: 2, heights: [20, 22] },
      { op: 'autoFilter', sheet: 'Sales', range: 'A1:D1' },
      { op: 'style', sheet: 'Sales', range: 'A1:D3', style: { border: 'medium' } },
      { op: 'style', sheet: 'Sales', range: 'A1', style: { border: 'none' } },
    ])
    const sheet = (await reopen(edited)).getWorksheet('Sales')
    expect(sheet?.getCell('B5').isMerged).toBe(true)
    expect(sheet?.getRow(3).height).toBe(22)
    expect(sheet?.autoFilter).toBe('A1:D1')
    expect(sheet?.getCell('D3').border.top?.style).toBe('medium')
    expect(sheet?.getCell('A1').border.top).toBeUndefined()
    const cleared = await editWorkbook(edited, [{ op: 'autoFilter', sheet: 'Sales', range: null }, { op: 'unmerge', sheet: 'Sales', range: 'A5:D5' }])
    const after = (await reopen(cleared)).getWorksheet('Sales')
    expect(after?.autoFilter).toBeUndefined()
    expect(after?.getCell('B5').isMerged).toBe(false)
  })

  it('rejects bad colors and font sizes', async () => {
    await expect(createWorkbook({ theme: { accent: 'blue' }, sheets: [{ name: 'S' }] })).rejects.toThrow('theme.accent')
    await expect(editWorkbook(await createWorkbook(sales), [{ op: 'style', sheet: 'Sales', range: 'A1', style: { size: 0 } }]))
      .rejects.toThrow('font size')
  })
})
