import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { createDocument, createPresentation, inspectDocument, readDocument, readPresentation, type ChartSpec } from '../src/index.js'

const sales: ChartSpec = {
  type: 'column',
  title: 'Sales by region',
  categories: ['North', 'South', 'East', 'West'],
  series: [{ name: 'Q1', values: [120, 90, 150, 60] }, { name: 'Q2', values: [80, 110, 95, 140], color: 'C00000' }],
  stacked: true,
  dataLabels: true,
}

describe('charts in docx', () => {
  it('embeds a native Word chart that reads back with its data', async () => {
    const bytes = await createDocument({
      theme: { accent: '1F4E79' },
      blocks: [{ type: 'heading', level: 1, text: 'Sales' }, { type: 'chart', chart: sales, width: 500, height: 300 }],
    })
    const zip = await JSZip.loadAsync(bytes)
    expect(Object.keys(zip.files).some(path => /^word\/charts\/chart\d+\.xml$/.test(path))).toBe(true)
    const read = await readDocument(bytes)
    expect(read.blocks[1]).toEqual({
      index: 1,
      type: 'chart',
      chart: {
        type: 'column',
        title: 'Sales by region',
        stacked: true,
        categories: ['North', 'South', 'East', 'West'],
        categoriesRef: expect.any(String),
        series: [
          { name: 'Q1', values: [120, 90, 150, 60], nameRef: expect.any(String), valuesRef: expect.any(String) },
          { name: 'Q2', values: [80, 110, 95, 140], nameRef: expect.any(String), valuesRef: expect.any(String) },
        ],
      },
    })
    expect((await inspectDocument(bytes)).charts).toBe(1)
  })

  it('makes pie charts with per-slice colors', async () => {
    const bytes = await createDocument({ blocks: [{ type: 'chart', chart: { type: 'pie', categories: ['A', 'B'], series: [{ name: 'Share', values: [70, 30] }] } }] })
    const block = (await readDocument(bytes)).blocks[0]
    expect(block?.type === 'chart' && block.chart.type).toBe('pie')
  })
})

describe('charts in pptx', () => {
  it('adds native PowerPoint charts that read back per slide', async () => {
    const bytes = await createPresentation({
      theme: { accent: '1F4E79' },
      slides: [
        { title: 'By region', chart: sales },
        { title: 'Mix', chart: { type: 'doughnut', categories: ['Online', 'Retail'], series: [{ name: 'Channel', values: [60, 40] }], dataLabels: true } },
        { title: 'Trend', chart: { type: 'line', categories: ['Jan', 'Feb', 'Mar'], series: [{ name: 'Visits', values: [5, null, 9] }] } },
      ],
    })
    const read = await readPresentation(bytes)
    expect(read.slides[0]?.charts[0]).toMatchObject({ type: 'column', title: 'Sales by region', stacked: true, categories: ['North', 'South', 'East', 'West'] })
    expect(read.slides[0]?.charts[0]?.series.map(series => series.name)).toEqual(['Q1', 'Q2'])
    expect(read.slides[1]?.charts[0]).toMatchObject({ type: 'doughnut', series: [{ name: 'Channel', values: [60, 40] }] })
    expect(read.slides[2]?.charts[0]).toMatchObject({ type: 'line', series: [{ values: [5, 0, 9] }] })
    expect(read.slides[0]?.title).toBe('By region')
  })

  it('validates chart specs', async () => {
    await expect(createPresentation({ slides: [{ chart: { type: 'pie', categories: ['A'], series: [{ name: 'a', values: [1] }, { name: 'b', values: [2] }] } }] }))
      .rejects.toThrow('exactly one series')
    await expect(createDocument({ blocks: [{ type: 'chart', chart: { type: 'column', categories: ['A'], series: [{ name: 'a', values: [1, 2] }] } }] }))
      .rejects.toThrow('more values than there are categories')
    await expect(createPresentation({ slides: [{ chart: { type: 'pie', categories: ['A'], series: [{ name: 'a', values: [-1] }] } }] }))
      .rejects.toThrow('negative')
  })
})
