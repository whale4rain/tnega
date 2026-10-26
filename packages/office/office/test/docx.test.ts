import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { createDocument, inspectDocument, readDocument, type DocumentSpec } from '../src/index.js'

const report: DocumentSpec = {
  title: 'Q2 Sales',
  blocks: [
    { type: 'heading', level: 1, text: 'Q2 Sales Report' },
    { type: 'paragraph', text: [{ text: 'Revenue grew ', bold: false }, { text: '12%', bold: true }, { text: ' quarter over quarter.' }] },
    { type: 'heading', level: 2, text: 'By region' },
    { type: 'table', header: true, rows: [['Region', 'Total'], ['North', '200'], ['South']] },
    { type: 'list', ordered: true, items: ['Expand South', 'Hire two reps'] },
    { type: 'pageBreak' },
    { type: 'paragraph', text: 'Appendix', align: 'center' },
  ],
}

describe('docx', () => {
  it('creates a document whose body reads back in order', async () => {
    const bytes = await createDocument(report)
    const read = await readDocument(bytes)
    expect(read.total).toBe(8)
    expect(read.truncated).toBe(false)
    expect(read.blocks.map(block => (block.type === 'table' ? block.rows : block.type === 'paragraph' ? block.text : block.chart))).toEqual([
      'Q2 Sales Report',
      'Revenue grew 12% quarter over quarter.',
      'By region',
      [['Region', 'Total'], ['North', '200'], ['South', '']],
      'Expand South',
      'Hire two reps',
      '',
      'Appendix',
    ])
    expect(read.blocks[0]).toMatchObject({ type: 'paragraph', style: 'Heading1' })
    const zip = await JSZip.loadAsync(bytes)
    expect(await zip.file('word/document.xml')?.async('string')).toContain('<w:b/>')
  })

  it('outlines headings, counts and words', async () => {
    const outline = await inspectDocument(await createDocument(report))
    expect(outline).toEqual({
      paragraphs: 7,
      tables: 1,
      charts: 0,
      words: 22,
      headings: [{ index: 0, level: 1, text: 'Q2 Sales Report' }, { index: 2, level: 2, text: 'By region' }],
    })
  })

  it('pages through blocks', async () => {
    const read = await readDocument(await createDocument(report), { offset: 2, limit: 2 })
    expect(read.blocks.map(block => block.index)).toEqual([2, 3])
    expect(read.truncated).toBe(true)
  })

  it('rejects files that are not docx', async () => {
    await expect(readDocument(new TextEncoder().encode('plain'))).rejects.toMatchObject({ code: 'OFFICE_INVALID' })
    const zip = new JSZip()
    zip.file('hello.txt', 'x')
    await expect(inspectDocument(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow('missing word/document.xml')
  })
})

describe('docx theme and page setup', () => {
  it('applies fonts, accent headings, header shading, page size, header, footer and page numbers', async () => {
    const bytes = await createDocument({
      theme: { font: 'Arial', headingFont: 'Georgia', accent: '1F4E79' },
      page: { size: 'Letter', orientation: 'landscape', margin: 2 },
      header: 'Acme Corp · Confidential',
      footer: 'Q2 Sales',
      pageNumbers: true,
      blocks: [
        { type: 'heading', level: 1, text: 'Report' },
        { type: 'table', header: true, rows: [['A', 'B'], ['1', '2']] },
      ],
    })
    const zip = await JSZip.loadAsync(bytes)
    const read = async (path: string) => (await zip.file(path)?.async('string')) ?? ''
    const styles = await read('word/styles.xml')
    expect(styles).toContain('w:ascii="Arial"')
    expect(styles).toContain('w:ascii="Georgia"')
    expect(styles).toContain('w:val="1F4E79"')
    const body = await read('word/document.xml')
    expect(body).toMatch(/<w:pgSz[^>]*w:w="15840"[^>]*w:h="12240"[^>]*w:orient="landscape"/)
    expect(body).toMatch(/<w:pgMar[^>]*w:top="1134"/)
    expect(body).toContain('w:fill="D2DCE4"')
    const parts = Object.keys(zip.files)
    const header = await read(parts.find(path => /word\/header\d*\.xml$/.test(path)) ?? '')
    const footer = await read(parts.find(path => /word\/footer\d*\.xml$/.test(path)) ?? '')
    expect(header).toContain('Acme Corp · Confidential')
    expect(footer).toContain('Q2 Sales')
    expect(footer).toContain('PAGE')
    expect(footer).toContain('NUMPAGES')
  })

  it('rejects invalid page setup and accent colors', async () => {
    await expect(createDocument({ theme: { accent: 'navy' }, blocks: [] })).rejects.toThrow('theme.accent')
    await expect(createDocument({ page: { margin: 30 }, blocks: [] })).rejects.toThrow('page.margin')
  })
})
