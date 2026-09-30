import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { createPresentation, inspectPresentation, readPresentation, type PresentationSpec } from '../src/index.js'

const deck: PresentationSpec = {
  title: 'Q2 Review',
  slides: [
    { title: 'Q2 Review', subtitle: 'Sales team' },
    { title: 'Highlights', bullets: ['Revenue +12%', 'South doubled'], notes: 'Mention the new hires.' },
    { title: 'By region', table: { header: true, rows: [['Region', 'Total'], ['North', '200']] } },
    { text: 'Questions?' },
  ],
}

describe('pptx', () => {
  it('creates a deck that reads back slide by slide', async () => {
    const read = await readPresentation(await createPresentation(deck))
    expect(read.total).toBe(4)
    expect(read.truncated).toBe(false)
    const [cover, highlights, regions, closing] = read.slides
    expect(cover).toMatchObject({ index: 1, title: 'Q2 Review' })
    expect(cover?.shapes.map(shape => shape.text)).toEqual(['Q2 Review', 'Sales team'])
    expect(highlights).toMatchObject({ title: 'Highlights', notes: 'Mention the new hires.' })
    expect(highlights?.shapes.find(shape => shape.name === 'Bullets')?.text).toBe('Revenue +12%\nSouth doubled')
    expect(regions?.tables).toEqual([[['Region', 'Total'], ['North', '200']]])
    expect(closing?.title).toBeUndefined()
    expect(closing?.shapes.map(shape => shape.text)).toEqual(['Questions?'])
  })

  it('outlines slide count, size and titles', async () => {
    const outline = await inspectPresentation(await createPresentation({ ...deck, layout: '4x3' }))
    expect(outline).toEqual({
      slides: 4,
      size: { width: 10, height: 7.5 },
      titles: [
        { index: 1, title: 'Q2 Review' },
        { index: 2, title: 'Highlights' },
        { index: 3, title: 'By region' },
        { index: 4, title: null },
      ],
    })
  })

  it('pages through slides', async () => {
    const read = await readPresentation(await createPresentation(deck), { start: 2, count: 2 })
    expect(read.slides.map(slide => slide.index)).toEqual([2, 3])
    expect(read.truncated).toBe(true)
  })

  it('rejects empty decks and non-pptx files', async () => {
    await expect(createPresentation({ slides: [] })).rejects.toMatchObject({ code: 'OFFICE_INVALID' })
    const zip = new JSZip()
    zip.file('word/document.xml', '<w:document/>')
    await expect(readPresentation(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow('missing ppt/presentation.xml')
  })
})
