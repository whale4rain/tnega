// @vitest-environment jsdom
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { chartConfig } from '../components/preview/ChartCanvas'
import { parseChart, workbookCharts } from './ooxml-chart'

const NS = 'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
const column = `<c:chartSpace ${NS}><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>Sales</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea>
<c:barChart><c:barDir val="col"/><c:grouping val="stacked"/>
<c:ser><c:tx><c:strRef><c:f>S!$B$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>Q1</c:v></c:pt></c:strCache></c:strRef></c:tx>
<c:spPr><a:solidFill><a:srgbClr val="1F4E79"/></a:solidFill></c:spPr>
<c:cat><c:strRef><c:strCache><c:ptCount val="2"/><c:pt idx="0"><c:v>North</c:v></c:pt><c:pt idx="1"><c:v>South</c:v></c:pt></c:strCache></c:strRef></c:cat>
<c:val><c:numRef><c:numCache><c:ptCount val="2"/><c:pt idx="0"><c:v>120</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser>
</c:barChart></c:plotArea></c:chart></c:chartSpace>`

describe('parseChart', () => {
  it('reads type, title, stacking, categories and cached values', () => {
    expect(parseChart(column)).toEqual({
      kind: 'column', title: 'Sales', stacked: true, categories: ['North', 'South'],
      series: [{ name: 'Q1', values: [120, null], color: '#1F4E79' }],
    })
  })

  it('maps charts to chart.js configs', () => {
    const config = chartConfig({ kind: 'bar', stacked: true, categories: ['a'], series: [{ name: 's', values: [1] }] })
    expect(config.type).toBe('bar')
    expect(config.options).toMatchObject({ indexAxis: 'y', scales: { x: { stacked: true } } })
    expect(chartConfig({ kind: 'area', stacked: false, categories: ['a'], series: [{ name: 's', values: [1] }] }).type).toBe('line')
  })
})

describe('workbookCharts', () => {
  it('finds charts per sheet through the drawing relationships', async () => {
    const zip = new JSZip()
    zip.file('xl/workbook.xml', '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sales Data" r:id="rId1"/></sheets></workbook>')
    zip.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
    zip.file('xl/worksheets/sheet1.xml', '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData/><drawing r:id="rId1"/></worksheet>')
    zip.file('xl/worksheets/_rels/sheet1.xml.rels', '<Relationships><Relationship Id="rId1" Target="../drawings/drawing1.xml"/></Relationships>')
    zip.file('xl/drawings/drawing1.xml', `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"><xdr:twoCellAnchor><xdr:from><xdr:col>5</xdr:col><xdr:row>1</xdr:row></xdr:from><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/></xdr:twoCellAnchor></xdr:wsDr>`)
    zip.file('xl/drawings/_rels/drawing1.xml.rels', '<Relationships><Relationship Id="rId1" Target="../charts/chart1.xml"/></Relationships>')
    zip.file('xl/charts/chart1.xml', column)
    const charts = await workbookCharts(zip)
    expect(charts.get('Sales Data')?.map(chart => [chart.kind, chart.anchor])).toEqual([['column', 'F2']])
  })
})
