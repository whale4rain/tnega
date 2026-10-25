import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { createDocument, editDocument, readDocument, type DocumentSpec } from '../src/index.js'

const base: DocumentSpec = {
  header: 'Acme Corp · Draft',
  blocks: [
    { type: 'heading', level: 1, text: 'Q2 Sales Report' },
    { type: 'paragraph', text: [{ text: 'Sales grew ', bold: true }, { text: '12% this quarter.' }] },
    { type: 'table', header: true, rows: [['Region', 'Total'], ['North', '200']] },
    { type: 'paragraph', text: 'Appendix' },
  ],
}

async function texts(bytes: Uint8Array): Promise<unknown[]> {
  return (await readDocument(bytes)).blocks.map(block => (block.type === 'paragraph' ? block.text : block.type === 'table' ? block.rows : `chart:${block.chart.type}`))
}

async function part(bytes: Uint8Array, pattern: RegExp): Promise<string> {
  const zip = await JSZip.loadAsync(bytes)
  const path = Object.keys(zip.files).find(name => pattern.test(name))
  return path ? await zip.file(path)?.async('string') ?? '' : ''
}

describe('editDocument', () => {
  it('replaces text across runs in the body and the header', async () => {
    const edited = await editDocument(await createDocument(base), [
      { op: 'replaceText', find: 'grew 12%', replace: 'rose 15%' },
      { op: 'replaceText', find: 'draft', replace: 'Final', matchCase: false },
    ])
    expect((await texts(edited))[1]).toBe('Sales rose 15% this quarter.')
    expect(await part(edited, /word\/header\d*\.xml$/)).toContain('Acme Corp · Final')
  })

  it('rewrites paragraphs and table cells while keeping their style and run formatting', async () => {
    const edited = await editDocument(await createDocument(base), [
      { op: 'setParagraph', index: 0, text: 'Q3 Sales Report' },
      { op: 'setParagraph', index: 1, text: [{ text: 'Flat quarter', italic: true }] },
      { op: 'setCell', index: 2, row: 1, column: 1, text: '250' },
    ])
    const read = await readDocument(edited)
    expect(read.blocks[0]).toMatchObject({ type: 'paragraph', style: 'Heading1', text: 'Q3 Sales Report' })
    expect(read.blocks[2]).toMatchObject({ type: 'table', rows: [['Region', 'Total'], ['North', '250']] })
    const body = await part(edited, /word\/document\.xml$/)
    // The first run was bold; the rewritten run keeps that and adds italics in schema order.
    expect(body).toMatch(/<w:rPr><w:b\/>(<w:bCs\/>)?<w:i\/><\/w:rPr><w:t xml:space="preserve">Flat quarter<\/w:t>/)
  })

  it('inserts headings, lists, tables and charts with their styles, numbering and parts', async () => {
    const edited = await editDocument(await createDocument(base), [
      { op: 'insert', at: 3, blocks: [
        { type: 'heading', level: 2, text: 'Next steps' },
        { type: 'list', ordered: true, items: ['Hire', 'Expand'] },
        { type: 'chart', chart: { type: 'pie', categories: ['A', 'B'], series: [{ name: 'Mix', values: [60, 40] }] } },
      ] },
      { op: 'insert', blocks: [{ type: 'list', items: ['Bullet at the end'] }] },
    ])
    expect(await texts(edited)).toEqual([
      'Q2 Sales Report', 'Sales grew 12% this quarter.', [['Region', 'Total'], ['North', '200']],
      'Next steps', 'Hire', 'Expand', 'chart:pie', 'Appendix', 'Bullet at the end',
    ])
    const numbering = await part(edited, /word\/numbering\.xml$/)
    const body = await part(edited, /word\/document\.xml$/)
    const numIds = [...body.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map(match => match[1])
    expect(new Set(numIds).size).toBe(2)
    for (const id of numIds) expect(numbering).toContain(`w:numId="${id}"`)
    expect(await part(edited, /word\/styles\.xml$/)).toContain('w:styleId="Heading2"')
  })

  it('gives each inserted chart its own part', async () => {
    const chart = { type: 'column' as const, categories: ['A'], series: [{ name: 'S', values: [1] }] }
    const edited = await editDocument(await createDocument(base), [{ op: 'insert', blocks: [{ type: 'chart', chart }, { type: 'chart', chart: { ...chart, type: 'line' } }] }])
    const files = Object.keys((await JSZip.loadAsync(edited)).files).filter(path => /^word\/charts\/chart\d+\.xml$/.test(path))
    expect(files).toHaveLength(2)
    expect((await texts(edited)).slice(-2)).toEqual(['chart:column', 'chart:line'])
  })

  it('creates the numbering part when the document has none', async () => {
    const zip = await JSZip.loadAsync(await createDocument(base))
    zip.remove('word/numbering.xml')
    const rels = (await zip.file('word/_rels/document.xml.rels')?.async('string')) ?? ''
    zip.file('word/_rels/document.xml.rels', rels.replace(/<Relationship [^>]*numbering[^>]*\/>/, ''))
    const edited = await editDocument(await zip.generateAsync({ type: 'uint8array' }), [{ op: 'insert', blocks: [{ type: 'list', ordered: true, items: ['One'] }] }])
    const out = await JSZip.loadAsync(edited)
    expect(await out.file('word/numbering.xml')?.async('string')).toContain('<w:abstractNum')
    expect(await out.file('word/_rels/document.xml.rels')?.async('string')).toContain('numbering')
  })

  it('deletes blocks and rejects bad targets without producing a file', async () => {
    const bytes = await createDocument(base)
    expect(await texts(await editDocument(bytes, [{ op: 'delete', index: 1, count: 2 }]))).toEqual(['Q2 Sales Report', 'Appendix'])
    await expect(editDocument(bytes, [{ op: 'replaceText', find: 'missing', replace: 'x' }])).rejects.toThrow('text not found')
    await expect(editDocument(bytes, [{ op: 'setParagraph', index: 2, text: 'x' }])).rejects.toThrow('is a table, not a paragraph')
    await expect(editDocument(bytes, [{ op: 'delete', index: 3, count: 5 }])).rejects.toThrow('cannot delete')
    await expect(editDocument(bytes, [{ op: 'setCell', index: 2, row: 9, column: 0, text: 'x' }])).rejects.toThrow('no cell')
  })
})
