import type { Document, Element } from '@xmldom/xmldom'
import { OfficeError } from './errors.js'
import { attribute, child, children, descendants } from './ooxml.js'
import { OoxmlPackage, R_NS, importInto, type Relationship } from './package.js'
import { buildDeck, type SlideSpec } from './pptx.js'
import { replaceInTree } from './text-edit.js'
import type { Theme } from './theme.js'

/**
 * 原地编辑 pptx：只改目标幻灯片与它引用的部件，母版、版式、主题与其它幻灯片原样保留。
 * 页码从 1 开始，与 `readPresentation` 一致；每一步都作用在前一步之后的文稿上。
 */
export type PresentationOp =
  /** 替换文字（跨 run 匹配）；给定 `slide` 时只在该页替换；找不到时报错。 */
  | { op: 'replaceText', find: string, replace: string, slide?: number, matchCase?: boolean }
  /** 重写一个形状的文字，保留首段与首个 run 的格式。`shape` 是形状名，或 `title` 表示标题。 */
  | { op: 'setText', slide: number, shape: string, text: string | string[] }
  /** 在第 `at` 页的位置插入新页（缺省追加到末尾），沿用文稿尺寸与空白版式。 */
  | { op: 'addSlides', at?: number, slides: SlideSpec[], theme?: Theme }
  | { op: 'deleteSlide', slide: number }
  /** 把一页移到第 `to` 页的位置。 */
  | { op: 'moveSlide', slide: number, to: number }

const PRESENTATION = 'ppt/presentation.xml'
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const REL = {
  slide: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide',
  slideLayout: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout',
  slideMaster: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster',
  notesSlide: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide',
  notesMaster: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster',
  chart: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart',
}
const EMU_PER_INCH = 914_400

interface SlideEntry {
  sldId: Element
  relId: string
  path: string
}

async function slideList(pkg: OoxmlPackage, presentation: Document): Promise<{ list: Element, slides: SlideEntry[] }> {
  const list = descendants(presentation, 'sldIdLst')[0]
  if (!list) throw new OfficeError('not a pptx file: missing slide list', 'OFFICE_INVALID')
  const rels = new Map((await pkg.relationships(PRESENTATION)).map(rel => [rel.id, rel.target]))
  const slides = children(list, 'sldId').flatMap(sldId => {
    const relId = sldId.getAttributeNS(R_NS, 'id') ?? ''
    const path = rels.get(relId)
    return path ? [{ sldId, relId, path }] : []
  })
  return { list, slides }
}

function slideAt(slides: SlideEntry[], number: number): SlideEntry {
  const slide = Number.isInteger(number) ? slides[number - 1] : undefined
  if (!slide) throw new OfficeError(`no slide ${number} (the deck has ${slides.length})`, 'OFFICE_INVALID')
  return slide
}

// --- text -------------------------------------------------------------------------

function shapeName(shape: Element): string {
  return attribute(descendants(child(shape, 'nvSpPr') ?? shape, 'cNvPr')[0], 'name') ?? ''
}

function findShape(slide: Document, wanted: string): Element {
  const shapes = descendants(slide, 'sp')
  const lower = wanted.toLowerCase()
  const byName = shapes.find(shape => shapeName(shape).toLowerCase() === lower)
  const byTitle = lower === 'title'
    ? shapes.find(shape => ['title', 'ctrTitle'].includes(attribute(descendants(shape, 'ph')[0], 'type') ?? ''))
    : undefined
  const shape = byName ?? byTitle
  if (!shape) {
    const names = shapes.map(shapeName).filter(Boolean).join(', ')
    throw new OfficeError(`no shape named "${wanted}" (shapes: ${names || 'none'})`, 'OFFICE_INVALID')
  }
  return shape
}

function setShapeText(slide: Document, shape: Element, lines: string[]): void {
  const body = child(shape, 'txBody')
  if (!body) throw new OfficeError(`shape "${shapeName(shape)}" has no text`, 'OFFICE_INVALID')
  const paragraphs = children(body, 'p')
  const template = paragraphs[0]
  const pPr = template ? child(template, 'pPr') : undefined
  const firstRun = template ? descendants(template, 'r')[0] : undefined
  const rPr = firstRun ? child(firstRun, 'rPr') : undefined
  for (const paragraph of paragraphs) body.removeChild(paragraph)
  for (const line of lines) {
    const paragraph = slide.createElementNS(A, 'a:p')
    if (pPr) paragraph.appendChild(importInto(slide, pPr))
    const run = slide.createElementNS(A, 'a:r')
    if (rPr) run.appendChild(importInto(slide, rPr))
    const text = slide.createElementNS(A, 'a:t')
    text.textContent = line
    run.appendChild(text)
    paragraph.appendChild(run)
    body.appendChild(paragraph)
  }
}

// --- slides ---------------------------------------------------------------------

async function removePart(pkg: OoxmlPackage, path: string): Promise<void> {
  pkg.remove(path)
  const rels = `${path.slice(0, path.lastIndexOf('/'))}/_rels/${path.slice(path.lastIndexOf('/') + 1)}.rels`
  if (pkg.has(rels)) pkg.remove(rels)
  await pkg.removeContentType(path)
}

async function deleteSlide(pkg: OoxmlPackage, list: Element, slide: SlideEntry): Promise<void> {
  // 只删属于这一页的部件（备注页、图表及其数据）；版式、图片等可能被共享，保留。
  for (const rel of await pkg.relationships(slide.path)) {
    if (rel.external) continue
    if (rel.type === REL.notesSlide) await removePart(pkg, rel.target)
    if (rel.type === REL.chart) {
      for (const inner of await pkg.relationships(rel.target)) {
        if (!inner.external) await removePart(pkg, inner.target)
      }
      await removePart(pkg, rel.target)
    }
  }
  await removePart(pkg, slide.path)
  await pkg.removeRelationship(PRESENTATION, slide.relId)
  list.removeChild(slide.sldId)
}

function slideSize(presentation: Document): { width: number, height: number } {
  const size = descendants(presentation, 'sldSz')[0]
  const cx = Number(attribute(size, 'cx'))
  const cy = Number(attribute(size, 'cy'))
  if (!(cx > 0 && cy > 0)) return { width: 10, height: 5.625 }
  return { width: cx / EMU_PER_INCH, height: cy / EMU_PER_INCH }
}

/** 新页用的版式：优先空白版式，其次只有标题的版式，最后是第一个版式。 */
async function pickLayout(pkg: OoxmlPackage): Promise<string> {
  const layouts: { path: string, type: string, name: string }[] = []
  for (const master of (await pkg.relationships(PRESENTATION)).filter(rel => rel.type === REL.slideMaster)) {
    for (const rel of (await pkg.relationships(master.target)).filter(each => each.type === REL.slideLayout)) {
      const layout = await pkg.xml(rel.target)
      const root = layout?.documentElement
      layouts.push({
        path: rel.target,
        type: root?.getAttribute('type') ?? '',
        name: (root ? attribute(descendants(root, 'cSld')[0], 'name') : undefined)?.toLowerCase() ?? '',
      })
    }
  }
  const layout = layouts.find(each => each.type === 'blank' || each.name === 'blank')
    ?? layouts.find(each => each.type === 'titleOnly')
    ?? layouts[0]
  if (!layout) throw new OfficeError('the deck has no slide layouts to add slides with', 'OFFICE_UNSUPPORTED')
  return layout.path
}

/**
 * 备注页需要备注母版。PowerPoint 新建的文稿在写第一条备注前没有备注母版，这时把生成器
 * 的备注母版（连同它的主题）复制过来，并登记到 presentation.xml。
 */
async function ensureNotesMaster(pkg: OoxmlPackage, presentation: Document, source: OoxmlPackage): Promise<string | undefined> {
  const existing = (await pkg.relationships(PRESENTATION)).find(rel => rel.type === REL.notesMaster)?.target
  if (existing) return existing
  const sourceMaster = (await source.relationships(PRESENTATION)).find(rel => rel.type === REL.notesMaster)?.target
  const root = presentation.documentElement
  if (!sourceMaster || !root) return undefined
  const path = await pkg.copyPart(source, sourceMaster)
  const relId = await pkg.addRelationship(PRESENTATION, REL.notesMaster, path)
  const list = presentation.createElementNS(P, 'p:notesMasterIdLst')
  const id = presentation.createElementNS(P, 'p:notesMasterId')
  id.setAttributeNS(R_NS, 'r:id', relId)
  list.appendChild(id)
  // CT_Presentation：notesMasterIdLst 紧跟在 sldMasterIdLst 之后。
  const after = child(root, 'sldMasterIdLst')
  root.insertBefore(list, after?.nextSibling ?? root.firstChild)
  return path
}

async function addSlides(pkg: OoxmlPackage, presentation: Document, op: Extract<PresentationOp, { op: 'addSlides' }>): Promise<void> {
  if (op.slides.length === 0) throw new OfficeError('addSlides needs at least one slide', 'OFFICE_INVALID')
  const { list, slides } = await slideList(pkg, presentation)
  const at = op.at ?? slides.length + 1
  if (!(Number.isInteger(at) && at >= 1 && at <= slides.length + 1)) {
    throw new OfficeError(`addSlides position ${at} is outside 1-${slides.length + 1}`, 'OFFICE_INVALID')
  }
  // 用同一套生成器按原文稿尺寸渲染新页，再把每页连同图表、备注搬进来。
  const source = await OoxmlPackage.open(await buildDeck(op.slides, {
    size: slideSize(presentation),
    ...(op.theme ? { theme: op.theme } : {}),
  }), 'pptx')
  const sourcePresentation = await source.requireXml(PRESENTATION, 'pptx')
  const { slides: sourceSlides } = await slideList(source, sourcePresentation)
  const layout = await pickLayout(pkg)
  const notesMaster = op.slides.some(slide => slide.notes)
    ? await ensureNotesMaster(pkg, presentation, source)
    : (await pkg.relationships(PRESENTATION)).find(rel => rel.type === REL.notesMaster)?.target
  const handled = (rel: Relationship): boolean => rel.type === REL.slideLayout || rel.type === REL.notesSlide
  const ids = children(list, 'sldId').map(node => Number(node.getAttribute('id')) || 0)
  let nextId = Math.max(255, ...ids) + 1
  const anchor = slides[at - 1]?.sldId ?? null
  for (const sourceSlide of sourceSlides) {
    const slidePath = await pkg.copyPart(source, sourceSlide.path, new Map(), handled)
    for (const rel of await source.relationships(sourceSlide.path)) {
      if (rel.type === REL.slideLayout) await pkg.setRelationship(slidePath, rel.id, rel.type, layout)
      if (rel.type === REL.notesSlide && notesMaster) {
        const notesPath = await pkg.copyPart(source, rel.target, new Map(), inner => inner.type === REL.notesMaster || inner.type === REL.slide)
        for (const inner of await source.relationships(rel.target)) {
          if (inner.type === REL.notesMaster) await pkg.setRelationship(notesPath, inner.id, inner.type, notesMaster)
          if (inner.type === REL.slide) await pkg.setRelationship(notesPath, inner.id, inner.type, slidePath)
        }
        await pkg.setRelationship(slidePath, rel.id, rel.type, notesPath)
      }
    }
    const relId = await pkg.addRelationship(PRESENTATION, REL.slide, slidePath)
    const sldId = presentation.createElementNS(P, 'p:sldId')
    sldId.setAttribute('id', String(nextId++))
    sldId.setAttributeNS(R_NS, 'r:id', relId)
    list.insertBefore(sldId, anchor)
  }
}

// --- entry point ------------------------------------------------------------------

/** 按顺序应用一批修改；任何一步失败都不产出文件。 */
export async function editPresentation(bytes: Uint8Array, ops: readonly PresentationOp[]): Promise<Uint8Array> {
  const pkg = await OoxmlPackage.open(bytes, 'pptx')
  const presentation = await pkg.requireXml(PRESENTATION, 'pptx')
  for (const [step, op] of ops.entries()) {
    const { list, slides } = await slideList(pkg, presentation)
    switch (op.op) {
      case 'replaceText': {
        if (!op.find) throw new OfficeError(`ops[${step}]: find must not be empty`, 'OFFICE_INVALID')
        const targets = op.slide === undefined ? slides : [slideAt(slides, op.slide)]
        let count = 0
        for (const slide of targets) {
          const document = await pkg.requireXml(slide.path, 'pptx')
          const root = document.documentElement
          if (!root) continue
          const replaced = replaceInTree(root, op.find, op.replace, op.matchCase ?? true)
          if (replaced > 0) pkg.setXml(slide.path, document)
          count += replaced
        }
        if (count === 0) throw new OfficeError(`ops[${step}]: text not found: ${JSON.stringify(op.find)}`, 'OFFICE_INVALID')
        break
      }
      case 'setText': {
        const slide = slideAt(slides, op.slide)
        const document = await pkg.requireXml(slide.path, 'pptx')
        setShapeText(document, findShape(document, op.shape), typeof op.text === 'string' ? op.text.split('\n') : op.text)
        pkg.setXml(slide.path, document)
        break
      }
      case 'addSlides':
        await addSlides(pkg, presentation, op)
        break
      case 'deleteSlide':
        await deleteSlide(pkg, list, slideAt(slides, op.slide))
        break
      case 'moveSlide': {
        const slide = slideAt(slides, op.slide)
        if (!(Number.isInteger(op.to) && op.to >= 1 && op.to <= slides.length)) {
          throw new OfficeError(`cannot move to slide ${op.to} (the deck has ${slides.length})`, 'OFFICE_INVALID')
        }
        list.removeChild(slide.sldId)
        const remaining = children(list, 'sldId')
        list.insertBefore(slide.sldId, remaining[op.to - 1] ?? null)
        break
      }
      default: {
        const unknown: never = op
        throw new OfficeError(`unknown presentation op: ${JSON.stringify(unknown)}`, 'OFFICE_INVALID')
      }
    }
  }
  pkg.setXml(PRESENTATION, presentation)
  return pkg.save()
}
