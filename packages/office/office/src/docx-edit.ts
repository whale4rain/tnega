import { DOMParser, type Document, type Element } from '@xmldom/xmldom'
import { createDocument, type DocBlock, type Inline } from './docx.js'
import { OfficeError } from './errors.js'
import { attribute, child, children, descendants } from './ooxml.js'
import { OoxmlPackage, importInto, relationshipAttributes } from './package.js'
import { replaceInTree, setText } from './text-edit.js'

/**
 * 原地编辑 docx：只改动目标段落、表格与引用到的部件，文档自己的样式、页眉页脚、
 * 图片与未建模的内容都原样保留。块的编号与 `readDocument` 一致（正文中的段落与表格，
 * 从 0 开始）；每一步都作用在前一步之后的文档上。
 */
export type DocumentOp =
  /** 替换正文、页眉与页脚中的文字，跨 run 匹配；找不到时报错。 */
  | { op: 'replaceText', find: string, replace: string, matchCase?: boolean }
  /** 重写一个段落的文字，保留段落样式与首个 run 的格式。 */
  | { op: 'setParagraph', index: number, text: Inline }
  /** 重写表格中一个单元格的文字（行列从 0 开始）。 */
  | { op: 'setCell', index: number, row: number, column: number, text: Inline }
  /** 在第 `at` 个块之前插入新块；缺省追加到末尾。 */
  | { op: 'insert', at?: number, blocks: DocBlock[] }
  /** 删除从第 `index` 个块开始的 `count` 个块（缺省 1）。 */
  | { op: 'delete', index: number, count?: number }

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const DOCUMENT = 'word/document.xml'
const NUMBERING_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering'
const NUMBERING_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml'

function bodyOf(document: Document): Element {
  const body = descendants(document, 'body')[0]
  if (!body) throw new OfficeError('not a docx file: missing document body', 'OFFICE_INVALID')
  return body
}

function blocksOf(body: Element): Element[] {
  return children(body).filter(element => element.localName === 'p' || element.localName === 'tbl')
}

function blockAt(body: Element, index: number, kind?: 'p' | 'tbl'): Element {
  const blocks = blocksOf(body)
  const block = Number.isInteger(index) ? blocks[index] : undefined
  if (!block) throw new OfficeError(`no block #${index} (the document has ${blocks.length})`, 'OFFICE_INVALID')
  if (kind && block.localName !== kind) {
    throw new OfficeError(`block #${index} is a ${block.localName === 'p' ? 'paragraph' : 'table'}, not a ${kind === 'p' ? 'paragraph' : 'table'}`, 'OFFICE_INVALID')
  }
  return block
}

function wElement(document: Document, name: string): Element {
  return document.createElementNS(W, `w:${name}`)
}

/** CT_RPr 的元素顺序；Word 对乱序的格式属性会报文件损坏。 */
const RPR_ORDER = [
  'rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'outline', 'shadow', 'emboss',
  'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden', 'color', 'spacing', 'w', 'kern', 'position', 'sz', 'szCs',
  'highlight', 'u', 'effect', 'bdr', 'shd', 'fitText', 'vertAlign', 'rtl', 'cs', 'em', 'lang', 'eastAsianLayout', 'specVanish', 'oMath',
]

function toggle(document: Document, rPr: Element, name: string, on: boolean | undefined): void {
  if (on === undefined) return
  const existing = child(rPr, name)
  if (existing) rPr.removeChild(existing)
  if (!on) return
  const flag = wElement(document, name)
  if (name === 'u') flag.setAttributeNS(W, 'w:val', 'single')
  const rank = RPR_ORDER.indexOf(name)
  const before = children(rPr).find(node => RPR_ORDER.indexOf(node.localName ?? '') > rank)
  rPr.insertBefore(flag, before ?? null)
}

/** 按 Inline 生成 run；每个 run 以 `base` 的格式为底，再叠加片段自己的粗斜体与下划线。 */
function runs(document: Document, text: Inline, base: Element | undefined): Element[] {
  const spans = typeof text === 'string' ? [{ text }] : text
  return spans.map(span => {
    const run = wElement(document, 'r')
    const rPr = base ? importInto(document, base) : wElement(document, 'rPr')
    if ('bold' in span) toggle(document, rPr, 'b', span.bold)
    if ('italic' in span) toggle(document, rPr, 'i', span.italic)
    if ('underline' in span) toggle(document, rPr, 'u', span.underline)
    if (rPr.childNodes.length > 0) run.appendChild(rPr)
    span.text.split('\n').forEach((line, index) => {
      if (index > 0) run.appendChild(wElement(document, 'br'))
      const t = wElement(document, 't')
      setText(t, line)
      run.appendChild(t)
    })
    return run
  })
}

function rewriteParagraph(document: Document, paragraph: Element, text: Inline): void {
  const firstRun = descendants(paragraph, 'r')[0]
  const base = firstRun ? child(firstRun, 'rPr') : undefined
  for (const node of children(paragraph)) {
    if (node.localName !== 'pPr') paragraph.removeChild(node)
  }
  for (const run of runs(document, text, base)) paragraph.appendChild(run)
}

// --- inserting blocks ---------------------------------------------------------

/** 补齐插入内容用到、而目标文档里没有的样式（连同 basedOn 链）。 */
async function copyStyles(target: OoxmlPackage, source: OoxmlPackage, nodes: Element[]): Promise<void> {
  const targetStyles = await target.xml('word/styles.xml')
  const sourceStyles = await source.xml('word/styles.xml')
  if (!targetStyles?.documentElement || !sourceStyles) return
  const existing = new Set(descendants(targetStyles, 'style').map(style => attribute(style, 'styleId')))
  const sourceById = new Map(descendants(sourceStyles, 'style').map(style => [attribute(style, 'styleId'), style]))
  const wanted = nodes.flatMap(node => ['pStyle', 'rStyle', 'tblStyle'].flatMap(name => descendants(node, name).map(ref => attribute(ref, 'val'))))
  const visit = (id: string | undefined): void => {
    if (!id || existing.has(id)) return
    const style = sourceById.get(id)
    if (!style) return
    existing.add(id)
    targetStyles.documentElement?.appendChild(importInto(targetStyles, style))
    for (const link of ['basedOn', 'next', 'link']) visit(attribute(child(style, link), 'val'))
  }
  wanted.forEach(visit)
  target.setXml('word/styles.xml', targetStyles)
}

async function numberingDocument(target: OoxmlPackage): Promise<{ path: string, document: Document }> {
  const rel = (await target.relationships(DOCUMENT)).find(each => each.type === NUMBERING_REL)
  if (rel) {
    const document = await target.xml(rel.target)
    if (document) return { path: rel.target, document }
  }
  const path = 'word/numbering.xml'
  const document = new DOMParser().parseFromString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering xmlns:w="${W}"/>`, 'text/xml')
  target.setXml(path, document)
  await target.setContentType(path, NUMBERING_TYPE)
  await target.addRelationship(DOCUMENT, NUMBERING_REL, path)
  return { path, document }
}

/** 列表编号：把插入内容引用的编号定义复制过来，并换成不冲突的新 id。 */
async function copyNumbering(target: OoxmlPackage, source: OoxmlPackage, nodes: Element[]): Promise<void> {
  const references = nodes.flatMap(node => descendants(node, 'numId'))
  if (references.length === 0) return
  const sourceRel = (await source.relationships(DOCUMENT)).find(each => each.type === NUMBERING_REL)
  const sourceNumbering = sourceRel ? await source.xml(sourceRel.target) : undefined
  if (!sourceNumbering) return
  const { path, document } = await numberingDocument(target)
  const root = document.documentElement
  if (!root) return
  const maxOf = (name: string, attr: string): number =>
    Math.max(0, ...descendants(document, name).map(node => Number(attribute(node, attr)) || 0))
  let nextAbstract = maxOf('abstractNum', 'abstractNumId') + 1
  let nextNum = maxOf('num', 'numId') + 1
  const mapped = new Map<string, string>()
  for (const reference of references) {
    const oldId = attribute(reference, 'val') ?? ''
    let newId = mapped.get(oldId)
    if (!newId) {
      const num = descendants(sourceNumbering, 'num').find(node => attribute(node, 'numId') === oldId)
      const abstractId = attribute(child(num ?? reference, 'abstractNumId'), 'val')
      const abstract = descendants(sourceNumbering, 'abstractNum').find(node => attribute(node, 'abstractNumId') === abstractId)
      if (!num || !abstract) continue
      const abstractCopy = importInto(document, abstract)
      abstractCopy.setAttributeNS(W, 'w:abstractNumId', String(nextAbstract))
      // CT_Numbering 要求所有 abstractNum 排在 num 之前。
      const firstNum = child(root, 'num')
      if (firstNum) root.insertBefore(abstractCopy, firstNum)
      else root.appendChild(abstractCopy)
      const numCopy = wElement(document, 'num')
      numCopy.setAttributeNS(W, 'w:numId', String(nextNum))
      const abstractRef = wElement(document, 'abstractNumId')
      abstractRef.setAttributeNS(W, 'w:val', String(nextAbstract))
      numCopy.appendChild(abstractRef)
      root.appendChild(numCopy)
      newId = String(nextNum)
      mapped.set(oldId, newId)
      nextAbstract++
      nextNum++
    }
    reference.setAttributeNS(W, 'w:val', newId)
  }
  target.setXml(path, document)
}

/** 图表、图片等通过关系引用的部件：复制过来并改写 r:id。 */
async function copyReferencedParts(target: OoxmlPackage, source: OoxmlPackage, nodes: Element[]): Promise<void> {
  const sourceRels = new Map((await source.relationships(DOCUMENT)).map(rel => [rel.id, rel]))
  const copied = new Map<string, string>()
  for (const node of nodes) {
    for (const reference of relationshipAttributes(node)) {
      const rel = sourceRels.get(reference.id)
      if (!rel || rel.external) continue
      const path = await target.copyPart(source, rel.target, copied)
      const id = await target.addRelationship(DOCUMENT, rel.type, path)
      reference.element.setAttributeNS(reference.element.lookupNamespaceURI('r') ?? 'http://schemas.openxmlformats.org/officeDocument/2006/relationships', `r:${reference.name}`, id)
    }
  }
}

/** 绘图对象的 `wp:docPr/@id` 在文档内必须唯一。 */
function renumberDrawings(document: Document, nodes: Element[]): void {
  const existing = descendants(document, 'docPr').map(node => Number(node.getAttribute('id')) || 0)
  let next = Math.max(0, ...existing) + 1
  for (const node of nodes) {
    for (const docPr of descendants(node, 'docPr')) docPr.setAttribute('id', String(next++))
  }
}

async function insertBlocks(target: OoxmlPackage, document: Document, at: number | undefined, blocks: DocBlock[]): Promise<void> {
  if (blocks.length === 0) throw new OfficeError('insert needs at least one block', 'OFFICE_INVALID')
  const body = bodyOf(document)
  const existing = blocksOf(body)
  if (at !== undefined && !(Number.isInteger(at) && at >= 0 && at <= existing.length)) {
    throw new OfficeError(`insert position ${at} is outside 0-${existing.length}`, 'OFFICE_INVALID')
  }
  // 用同一套生成器渲染新块，再把它们连同依赖搬进目标文档。
  const source = await OoxmlPackage.open(await createDocument({ blocks }), 'docx')
  const sourceBody = bodyOf(await source.requireXml(DOCUMENT, 'docx'))
  const nodes = children(sourceBody).filter(node => node.localName !== 'sectPr').map(node => importInto(document, node))
  await copyStyles(target, source, nodes)
  await copyNumbering(target, source, nodes)
  await copyReferencedParts(target, source, nodes)
  renumberDrawings(document, nodes)
  const anchor = at === undefined || at === existing.length
    ? children(body).find(node => node.localName === 'sectPr') ?? null
    : existing[at] ?? null
  for (const node of nodes) body.insertBefore(node, anchor)
}

// --- entry point ----------------------------------------------------------------

async function headerFooterParts(target: OoxmlPackage): Promise<string[]> {
  return (await target.relationships(DOCUMENT))
    .filter(rel => /\/(header|footer)$/.test(rel.type))
    .map(rel => rel.target)
}

/** 按顺序应用一批修改；任何一步失败都不产出文件。 */
export async function editDocument(bytes: Uint8Array, ops: readonly DocumentOp[]): Promise<Uint8Array> {
  const target = await OoxmlPackage.open(bytes, 'docx')
  const document = await target.requireXml(DOCUMENT, 'docx')
  const body = bodyOf(document)
  for (const [step, op] of ops.entries()) {
    switch (op.op) {
      case 'replaceText': {
        if (!op.find) throw new OfficeError(`ops[${step}]: find must not be empty`, 'OFFICE_INVALID')
        const matchCase = op.matchCase ?? true
        let count = replaceInTree(body, op.find, op.replace, matchCase)
        for (const part of await headerFooterParts(target)) {
          const partXml = await target.xml(part)
          if (!partXml?.documentElement) continue
          const replaced = replaceInTree(partXml.documentElement, op.find, op.replace, matchCase)
          if (replaced > 0) target.setXml(part, partXml)
          count += replaced
        }
        if (count === 0) throw new OfficeError(`ops[${step}]: text not found: ${JSON.stringify(op.find)}`, 'OFFICE_INVALID')
        break
      }
      case 'setParagraph':
        rewriteParagraph(document, blockAt(body, op.index, 'p'), op.text)
        break
      case 'setCell': {
        const table = blockAt(body, op.index, 'tbl')
        const row = children(table, 'tr')[op.row]
        const cell = row ? children(row, 'tc')[op.column] : undefined
        if (!cell) throw new OfficeError(`table #${op.index} has no cell at row ${op.row}, column ${op.column}`, 'OFFICE_INVALID')
        const [first, ...rest] = children(cell, 'p')
        for (const extra of rest) cell.removeChild(extra)
        let paragraph = first
        if (!paragraph) {
          paragraph = wElement(document, 'p')
          cell.appendChild(paragraph)
        }
        rewriteParagraph(document, paragraph, op.text)
        break
      }
      case 'insert':
        await insertBlocks(target, document, op.at, op.blocks)
        break
      case 'delete': {
        const count = op.count ?? 1
        const blocks = blocksOf(body)
        if (!(Number.isInteger(op.index) && Number.isInteger(count) && count >= 1 && op.index >= 0 && op.index + count <= blocks.length)) {
          throw new OfficeError(`cannot delete ${count} block(s) from #${op.index} (the document has ${blocks.length})`, 'OFFICE_INVALID')
        }
        for (const block of blocks.slice(op.index, op.index + count)) body.removeChild(block)
        break
      }
      default: {
        const unknown: never = op
        throw new OfficeError(`unknown document op: ${JSON.stringify(unknown)}`, 'OFFICE_INVALID')
      }
    }
  }
  target.setXml(DOCUMENT, document)
  return target.save()
}
