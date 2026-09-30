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
    expect(read.blocks.map(block => (block.type === 'table' ? block.rows : block.text))).toEqual([
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
