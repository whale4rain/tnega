import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { createPresentation, editPresentation, readPresentation, type PresentationSpec } from '../src/index.js'

const deck: PresentationSpec = {
  layout: '4x3',
  slides: [
    { title: 'Q2 Review', subtitle: 'Acme · Draft' },
    { title: 'Highlights', bullets: ['Revenue up', 'Draft numbers'], notes: 'Lead with revenue.' },
    { title: 'Mix', chart: { type: 'pie', categories: ['A', 'B'], series: [{ name: 'S', values: [60, 40] }] }, notes: 'Pie notes' },
  ],
}

async function titles(bytes: Uint8Array): Promise<(string | undefined)[]> {
  return (await readPresentation(bytes)).slides.map(slide => slide.title)
}

describe('editPresentation', () => {
  it('replaces text across slides or on one slide', async () => {
    const bytes = await createPresentation(deck)
    const all = await editPresentation(bytes, [{ op: 'replaceText', find: 'Draft', replace: 'Final' }])
    const read = await readPresentation(all)
    expect(read.slides[0]?.shapes.map(shape => shape.text)).toContain('Acme · Final')
    expect(read.slides[1]?.shapes.find(shape => shape.name === 'Bullets')?.text).toBe('Revenue up\nFinal numbers')
    const one = await readPresentation(await editPresentation(bytes, [{ op: 'replaceText', find: 'Draft', replace: 'X', slide: 1 }]))
    expect(one.slides[1]?.shapes.find(shape => shape.name === 'Bullets')?.text).toContain('Draft numbers')
  })

  it('rewrites a shape keeping its formatting', async () => {
    const edited = await editPresentation(await createPresentation({ ...deck, theme: { accent: '1F4E79' } }), [
      { op: 'setText', slide: 2, shape: 'title', text: 'Key wins' },
      { op: 'setText', slide: 2, shape: 'Bullets', text: ['One', 'Two', 'Three'] },
    ])
    const slide = (await readPresentation(edited)).slides[1]
    expect(slide?.title).toBe('Key wins')
    expect(slide?.shapes.find(shape => shape.name === 'Bullets')?.text).toBe('One\nTwo\nThree')
    const xml = (await (await JSZip.loadAsync(edited)).file('ppt/slides/slide2.xml')?.async('string')) ?? ''
    expect(xml).toMatch(/<a:rPr[^>]*b="1"[^>]*>.*?<a:srgbClr val="1F4E79"\/>.*?<\/a:rPr><a:t>Key wins<\/a:t>/)
  })

  it('adds slides with charts and notes at a position, sized to the deck', async () => {
    const edited = await editPresentation(await createPresentation(deck), [{
      op: 'addSlides',
      at: 2,
      slides: [
        { title: 'Trend', chart: { type: 'line', categories: ['Jan', 'Feb'], series: [{ name: 'Visits', values: [3, 5] }] }, notes: 'New notes' },
        { title: 'Agenda', bullets: ['A', 'B'] },
      ],
    }])
    const read = await readPresentation(edited)
    expect(read.slides.map(slide => slide.title)).toEqual(['Q2 Review', 'Trend', 'Agenda', 'Highlights', 'Mix'])
    expect(read.slides[1]?.charts[0]).toMatchObject({ type: 'line', series: [{ name: 'Visits', values: [3, 5] }] })
    expect(read.slides[1]?.notes).toBe('New notes')
    expect(read.slides[4]?.charts[0]?.type).toBe('pie')
    const zip = await JSZip.loadAsync(edited)
    const files = Object.keys(zip.files)
    expect(files.filter(path => /^ppt\/charts\/chart\d+\.xml$/.test(path))).toHaveLength(2)
    const added = (await zip.file('ppt/slides/slide4.xml')?.async('string')) ?? ''
    // Shapes are laid out for the deck's 10 x 7.5 in slides, not the generator's default size.
    expect(added).toMatch(/<a:ext cx="8229600"/)
    const types = (await zip.file('[Content_Types].xml')?.async('string')) ?? ''
    expect(types).toContain('/ppt/slides/slide4.xml')
  })

  it('brings a notes master along when the deck has none', async () => {
    const zip = await JSZip.loadAsync(await createPresentation({ slides: [{ title: 'Only' }] }))
    for (const path of Object.keys(zip.files)) {
      if (/^ppt\/(notesMasters|notesSlides)\//.test(path)) zip.remove(path)
    }
    const strip = async (path: string, pattern: RegExp) => zip.file(path, ((await zip.file(path)?.async('string')) ?? '').replace(pattern, ''))
    await strip('ppt/presentation.xml', /<p:notesMasterIdLst>.*?<\/p:notesMasterIdLst>/)
    await strip('ppt/_rels/presentation.xml.rels', /<Relationship [^>]*notesMaster[^>]*\/>/g)
    await strip('ppt/slides/_rels/slide1.xml.rels', /<Relationship [^>]*notesSlide[^>]*\/>/g)
    const bare = await zip.generateAsync({ type: 'uint8array' })
    const edited = await editPresentation(bare, [{ op: 'addSlides', slides: [{ title: 'With notes', notes: 'Remember this' }] }])
    expect((await readPresentation(edited)).slides[1]?.notes).toBe('Remember this')
    const presentation = (await (await JSZip.loadAsync(edited)).file('ppt/presentation.xml')?.async('string')) ?? ''
    expect(presentation).toMatch(/<\/p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId r:id="rId\d+"\/><\/p:notesMasterIdLst>/)
  })

  it('deletes and moves slides, removing the deleted slide parts', async () => {
    const bytes = await createPresentation(deck)
    const edited = await editPresentation(bytes, [{ op: 'deleteSlide', slide: 3 }, { op: 'moveSlide', slide: 2, to: 1 }])
    expect(await titles(edited)).toEqual(['Highlights', 'Q2 Review'])
    const files = Object.keys((await JSZip.loadAsync(edited)).files)
    // JSZip lists folders too; only real parts matter.
    expect(files.some(path => /^ppt\/charts\/.+[^/]$/.test(path))).toBe(false)
    expect(files).not.toContain('ppt/slides/slide3.xml')
  })

  it('rejects bad targets without producing a file', async () => {
    const bytes = await createPresentation(deck)
    await expect(editPresentation(bytes, [{ op: 'setText', slide: 9, shape: 'title', text: 'x' }])).rejects.toThrow('no slide 9')
    await expect(editPresentation(bytes, [{ op: 'setText', slide: 2, shape: 'Nope', text: 'x' }])).rejects.toThrow('shapes: Title, Bullets')
    await expect(editPresentation(bytes, [{ op: 'replaceText', find: 'zzz', replace: 'x' }])).rejects.toThrow('text not found')
    await expect(editPresentation(bytes, [{ op: 'moveSlide', slide: 1, to: 7 }])).rejects.toThrow('cannot move')
  })
})
