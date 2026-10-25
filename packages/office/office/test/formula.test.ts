import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { WorkbookEvaluator, createWorkbook, displayValue, parseFormula, readRange, type CellInput } from '../src/index.js'

function evaluate(rows: CellInput[][], address = { row: 1, column: rows[0]?.length ?? 1 }, extra?: (workbook: ExcelJS.Workbook) => void) {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Data')
  rows.forEach((row, r) => row.forEach((value, c) => {
    sheet.getCell(r + 1, c + 1).value = value !== null && typeof value === 'object' ? { formula: value.formula } : value
  }))
  extra?.(workbook)
  return displayValue(new WorkbookEvaluator(workbook).cell('Data', address.row, address.column))
}

describe('formula evaluation', () => {
  it('follows Excel precedence for operators', () => {
    expect(evaluate([[{ formula: '1+2*3^2' }]])).toBe(19)
    expect(evaluate([[{ formula: '-2^2' }]])).toBe(4)
    expect(evaluate([[{ formula: '(1+2)*3' }]])).toBe(9)
    expect(evaluate([[{ formula: '50%*4' }]])).toBe(2)
    expect(evaluate([[{ formula: '"a"&1&TRUE' }]])).toBe('a1TRUE')
    expect(evaluate([[{ formula: '2>1' }]])).toBe(true)
    expect(evaluate([[{ formula: '"b"="B"' }]])).toBe(true)
  })

  it('resolves references, ranges and other sheets through formulajs functions', () => {
    expect(evaluate([[10, 20, { formula: 'SUM(A1:B1)*2' }]])).toBe(60)
    expect(evaluate([[10, 20, { formula: 'IF(AVERAGE(A1:B1)>12,"high","low")' }]])).toBe('high')
    expect(evaluate([[1, { formula: 'A1+1' }, { formula: 'B1*10' }]])).toBe(20)
    expect(evaluate([[{ formula: "ROUND('My Sheet'!$A$1/3,2)" }]], undefined, workbook => {
      workbook.addWorksheet('My Sheet').getCell('A1').value = 10
    })).toBe(3.33)
    expect(evaluate([['b', 2], ['c', 3], [{ formula: 'VLOOKUP("c",A1:B2,2,FALSE)' }]], { row: 3, column: 1 })).toBe(3)
  })

  it('returns Excel error codes instead of throwing', () => {
    expect(evaluate([[{ formula: '1/0' }]])).toBe('#DIV/0!')
    expect(evaluate([[{ formula: 'NOPE(1)' }]])).toBe('#NAME?')
    expect(evaluate([[{ formula: 'MyRange*2' }]])).toBe('#NAME?')
    expect(evaluate([['x', { formula: 'A1*2' }]])).toBe('#VALUE!')
    expect(evaluate([[{ formula: 'B1' }, { formula: 'A1' }]], { row: 1, column: 1 })).toBe('#CIRCULAR!')
    expect(evaluate([[{ formula: '1/0' }, { formula: 'A1+1' }]])).toBe('#DIV/0!')
  })

  it('rejects malformed formulas at parse time', () => {
    expect(() => parseFormula('SUM(1,')).toThrow()
    expect(() => parseFormula('1 2')).toThrow()
  })

  it('stores computed results so readers without an engine see values', async () => {
    const bytes = await createWorkbook({ sheets: [{ name: 'Data', rows: [[2, 3, { formula: 'A1*B1' }, { formula: 'A1/0' }]] }] })
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(bytes.slice().buffer)
    const sheet = workbook.getWorksheet('Data')
    expect(sheet?.getCell('C1').value).toEqual({ formula: 'A1*B1', result: 6 })
    expect(sheet?.getCell('D1').value).toEqual({ formula: 'A1/0' })
    expect((await readRange(bytes)).rows[0]).toEqual([2, 3, { formula: 'A1*B1', value: 6 }, { formula: 'A1/0', value: '#DIV/0!' }])
  })
})
