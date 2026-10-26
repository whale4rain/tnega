import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { createWorkbook, editWorkbook, inspectWorkbook, parseSheetRef, formatSheetRef, readRange, type WorkbookSpec } from '../src/index.js'

const spec: WorkbookSpec = {
  theme: { accent: '1F4E79' },
  sheets: [{
    name: 'Sales Data',
    rows: [
      ['Region', 'Q1', 'Q2', 'Total'],
      ['North', 120, 80, { formula: 'B2+C2' }],
      ['South', 90, 110, { formula: 'B3+C3' }],
      ['East', 150, 95, { formula: 'B4+C4' }],
    ],
    charts: [
      { type: 'column', title: 'Sales by region', categories: 'A2:A4', series: [{ values: 'B2:B4' }, { values: 'C2:C4', color: 'C00000' }], at: 'F2' },
      { type: 'pie', title: 'Total share', categories: 'A2:A4', series: [{ values: 'D2:D4' }], at: 'F20', dataLabels: true },
    ],
  }],
}

async function parts(bytes: Uint8Array): Promise<{ zip: JSZip, read: (path: string) => Promise<string> }> {
  const zip = await JSZip.loadAsync(bytes)
  return { zip, read: async path => (await zip.file(path)?.async('string')) ?? '' }
}

describe('sheet references', () => {
  it('parses and formats quoted sheet names', () => {
    const ref = parseSheetRef("'Sales Data'!B2:B4", 'Other')
    expect(ref.sheet).toBe('Sales Data')
    expect(formatSheetRef(ref)).toBe("'Sales Data'!$B$2:$B$4")
    expect(formatSheetRef(parseSheetRef('A1', 'Data'))).toBe('Data!$A$1')
  })
})

describe('xlsx charts', () => {
  it('writes native chart parts with cached values from formulas', async () => {
    const bytes = await createWorkbook(spec)
    const { zip, read } = await parts(bytes)
    const files = Object.keys(zip.files)
    expect(files).toEqual(expect.arrayContaining(['xl/charts/chart1.xml', 'xl/charts/chart2.xml', 'xl/drawings/drawing1.xml', 'xl/drawings/_rels/drawing1.xml.rels']))
    expect(await read('[Content_Types].xml')).toContain('/xl/charts/chart1.xml')
    expect(await read('xl/worksheets/sheet1.xml')).toMatch(/<drawing r:id="rId\d+"\/>/)
    const column = await read('xl/charts/chart1.xml')
    expect(column).toContain("<c:f>'Sales Data'!$B$2:$B$4</c:f>")
    expect(column).toContain('<c:barDir val="col"/>')
    expect(column).toContain('<a:srgbClr val="1F4E79"/>')
    expect(column).toContain('<a:srgbClr val="C00000"/>')
    expect(column).toContain('<c:v>Q1</c:v>')
    const pie = await read('xl/charts/chart2.xml')
    expect(pie).toContain('<c:pt idx="0"><c:v>200</c:v></c:pt>')
    expect(pie).toContain('<c:showPercent val="1"/>')
  })

  it('outlines charts with resolved series names', async () => {
    const outline = await inspectWorkbook(await createWorkbook(spec))
    expect(outline.sheets[0]?.charts).toEqual([
      { index: 0, type: 'column', title: 'Sales by region', at: 'F2', categories: "'Sales Data'!$A$2:$A$4", series: [{ name: 'Q1', values: "'Sales Data'!$B$2:$B$4" }, { name: 'Q2', values: "'Sales Data'!$C$2:$C$4" }] },
      { index: 1, type: 'pie', title: 'Total share', at: 'F20', categories: "'Sales Data'!$A$2:$A$4", series: [{ name: 'Total', values: "'Sales Data'!$D$2:$D$4" }] },
    ])
  })

  it('keeps charts through edits and refreshes their cached values', async () => {
    const edited = await editWorkbook(await createWorkbook(spec), [{ op: 'setCells', sheet: 'Sales Data', start: 'B2', rows: [[500]] }])
    const { zip, read } = await parts(edited)
    expect(Object.keys(zip.files).filter(path => /^xl\/charts\/chart\d+\.xml$/.test(path))).toHaveLength(2)
    expect(Object.keys(zip.files).filter(path => /^xl\/drawings\/drawing\d+\.xml$/.test(path))).toHaveLength(1)
    expect(await read('xl/charts/chart1.xml')).toContain('<c:pt idx="0"><c:v>500</c:v></c:pt>')
    expect(await read('xl/charts/chart2.xml')).toContain('<c:pt idx="0"><c:v>580</c:v></c:pt>')
    expect(await read('xl/charts/chart1.xml')).toContain('<a:srgbClr val="C00000"/>')
    expect((await readRange(edited, { range: 'D2' })).rows[0]?.[0]).toEqual({ formula: 'B2+C2', value: 580 })
  })

  it('adds, removes and renames with charts', async () => {
    let bytes = await createWorkbook(spec)
    bytes = await editWorkbook(bytes, [
      { op: 'removeChart', sheet: 'Sales Data', index: 1 },
      { op: 'addSheet', name: 'Dashboard' },
      { op: 'addChart', sheet: 'Dashboard', chart: { type: 'line', categories: "'Sales Data'!A2:A4", series: [{ values: "'Sales Data'!D2:D4", name: 'Total' }], at: 'B2' } },
      { op: 'renameSheet', sheet: 'Sales Data', name: 'Data' },
    ])
    const outline = await inspectWorkbook(bytes)
    expect(outline.sheets.map(sheet => [sheet.name, sheet.charts.map(chart => chart.type)])).toEqual([['Data', ['column']], ['Dashboard', ['line']]])
    expect(outline.sheets[1]?.charts[0]?.series[0]?.values).toBe('Data!$D$2:$D$4')
    await expect(editWorkbook(bytes, [{ op: 'deleteSheet', sheet: 'Data' }])).rejects.toThrow('uses data from "Data"')
    await expect(editWorkbook(bytes, [{ op: 'removeChart', sheet: 'Data', index: 3 }])).rejects.toThrow('no chart #3')
  })

  it('refuses to edit workbooks with charts it cannot rebuild', async () => {
    const { zip, read } = await parts(await createWorkbook(spec))
    zip.file('xl/charts/chart1.xml', (await read('xl/charts/chart1.xml')).replace('<c:barChart>', '<c:radarChart>').replace('</c:barChart>', '</c:radarChart>'))
    const tampered = await zip.generateAsync({ type: 'uint8array' })
    await expect(editWorkbook(tampered, [{ op: 'setCells', sheet: 'Sales Data', start: 'A1', rows: [['x']] }])).rejects.toMatchObject({ code: 'OFFICE_UNSUPPORTED' })
  })

  it('validates chart specs before writing', async () => {
    await expect(createWorkbook({ sheets: [{ name: 'S', charts: [{ type: 'pie', categories: 'A1:A2', series: [{ values: 'B1:B2' }, { values: 'C1:C2' }], at: 'E1' }] }] }))
      .rejects.toThrow('exactly one series')
    await expect(createWorkbook({ sheets: [{ name: 'S', charts: [{ type: 'column', categories: 'A1:A2', series: [{ values: 'B1:B2' }], at: 'nowhere' }] }] }))
      .rejects.toThrow('invalid cell address')
  })
})
