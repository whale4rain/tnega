import { DOMParser, XMLSerializer, type Document, type Element } from '@xmldom/xmldom'
import JSZip from 'jszip'
import { OfficeError } from './errors.js'
import { children, descendants } from './ooxml.js'

/**
 * 可写的 OOXML 包：按部件读写 XML，维护关系与内容类型，并能把另一个包里的部件
 * （连同它引用的部件）复制进来。docx / pptx 的原地编辑都建立在它之上。
 */

const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types'
export const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

export interface Relationship {
  id: string
  type: string
  /** 包内绝对路径（不带前导 `/`）；外部链接保留原值。 */
  target: string
  external: boolean
}

function directory(path: string): string {
  return path.slice(0, path.lastIndexOf('/'))
}

export function relsPathOf(part: string): string {
  return `${directory(part)}/_rels/${part.slice(part.lastIndexOf('/') + 1)}.rels`
}

function resolveTarget(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = base.split('/').filter(Boolean)
  for (const segment of target.split('/')) {
    if (segment === '..') parts.pop()
    else if (segment !== '.') parts.push(segment)
  }
  return parts.join('/')
}

function relativeTarget(from: string, to: string): string {
  const fromParts = directory(from).split('/').filter(Boolean)
  const toParts = to.split('/')
  let common = 0
  while (common < fromParts.length && fromParts[common] === toParts[common]) common++
  return [...fromParts.slice(common).map(() => '..'), ...toParts.slice(common)].join('/')
}

export class OoxmlPackage {
  private readonly cache = new Map<string, Document>()

  private constructor(readonly zip: JSZip) {}

  static async open(bytes: Uint8Array, kind: string): Promise<OoxmlPackage> {
    try {
      return new OoxmlPackage(await JSZip.loadAsync(bytes))
    } catch (error) {
      throw new OfficeError(`not a readable ${kind} file`, 'OFFICE_INVALID', { cause: error })
    }
  }

  has(path: string): boolean {
    return this.zip.file(path) !== null
  }

  async xml(path: string): Promise<Document | undefined> {
    const cached = this.cache.get(path)
    if (cached) return cached
    const text = await this.zip.file(path)?.async('string')
    if (text === undefined) return undefined
    const document = new DOMParser().parseFromString(text, 'text/xml')
    this.cache.set(path, document)
    return document
  }

  async requireXml(path: string, kind: string): Promise<Document> {
    const document = await this.xml(path)
    if (!document) throw new OfficeError(`not a ${kind} file: missing ${path}`, 'OFFICE_INVALID')
    return document
  }

  /** 标记一个已修改的 XML 部件，在 `save` 时写回。 */
  setXml(path: string, document: Document): void {
    this.cache.set(path, document)
  }

  remove(path: string): void {
    this.zip.remove(path)
    this.cache.delete(path)
  }

  async save(): Promise<Uint8Array> {
    const serializer = new XMLSerializer()
    for (const [path, document] of this.cache) this.zip.file(path, serializer.serializeToString(document))
    return this.zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
  }

  // --- relationships ---------------------------------------------------------

  private async relsDocument(part: string): Promise<Document> {
    const path = relsPathOf(part)
    const existing = await this.xml(path)
    if (existing) return existing
    const created = new DOMParser().parseFromString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${RELS_NS}"/>`, 'text/xml')
    this.setXml(path, created)
    return created
  }

  async relationships(part: string): Promise<Relationship[]> {
    const document = await this.xml(relsPathOf(part))
    if (!document) return []
    return descendants(document, 'Relationship').map(rel => {
      const external = rel.getAttribute('TargetMode') === 'External'
      const target = rel.getAttribute('Target') ?? ''
      return {
        id: rel.getAttribute('Id') ?? '',
        type: rel.getAttribute('Type') ?? '',
        target: external ? target : resolveTarget(directory(part), target),
        external,
      }
    })
  }

  async addRelationship(part: string, type: string, target: string): Promise<string> {
    const document = await this.relsDocument(part)
    const ids = new Set(descendants(document, 'Relationship').map(rel => rel.getAttribute('Id')))
    let next = ids.size + 1
    while (ids.has(`rId${next}`)) next++
    const rel = document.createElementNS(RELS_NS, 'Relationship')
    rel.setAttribute('Id', `rId${next}`)
    rel.setAttribute('Type', type)
    rel.setAttribute('Target', relativeTarget(part, target))
    document.documentElement?.appendChild(rel)
    return `rId${next}`
  }

  async removeRelationship(part: string, id: string): Promise<void> {
    const document = await this.xml(relsPathOf(part))
    const rel = document ? descendants(document, 'Relationship').find(each => each.getAttribute('Id') === id) : undefined
    rel?.parentNode?.removeChild(rel)
  }

  // --- content types ---------------------------------------------------------

  async contentTypeOf(path: string): Promise<string | undefined> {
    const types = await this.requireXml('[Content_Types].xml', 'OOXML')
    const override = descendants(types, 'Override').find(node => node.getAttribute('PartName') === `/${path}`)
    if (override) return override.getAttribute('ContentType') ?? undefined
    const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
    return descendants(types, 'Default').find(node => node.getAttribute('Extension')?.toLowerCase() === extension)?.getAttribute('ContentType') ?? undefined
  }

  async setContentType(path: string, contentType: string): Promise<void> {
    const types = await this.requireXml('[Content_Types].xml', 'OOXML')
    const name = `/${path}`
    if (descendants(types, 'Override').some(node => node.getAttribute('PartName') === name)) return
    const override = types.createElementNS(TYPES_NS, 'Override')
    override.setAttribute('PartName', name)
    override.setAttribute('ContentType', contentType)
    types.documentElement?.appendChild(override)
  }

  async removeContentType(path: string): Promise<void> {
    const types = await this.requireXml('[Content_Types].xml', 'OOXML')
    const override = descendants(types, 'Override').find(node => node.getAttribute('PartName') === `/${path}`)
    override?.parentNode?.removeChild(override)
  }

  // --- copying ---------------------------------------------------------------

  /** 在同一目录下找一个未被占用的部件名，例如 `ppt/charts/chart3.xml`。 */
  freePath(path: string): string {
    if (!this.has(path)) return path
    const dot = path.lastIndexOf('.')
    const stem = path.slice(0, dot).replace(/\d+$/, '')
    const extension = path.slice(dot)
    for (let index = 1; ; index++) {
      const candidate = `${stem}${index}${extension}`
      if (!this.has(candidate)) return candidate
    }
  }

  /**
   * 把 `source` 包里的一个部件复制进来，连同它的关系递归复制所引用的部件。
   * `skip` 返回 true 的关系不复制（由调用方另行处理，例如版式与母版）。
   * 返回新部件在本包中的路径。
   */
  async copyPart(
    source: OoxmlPackage,
    path: string,
    copied = new Map<string, string>(),
    skip: (rel: Relationship) => boolean = () => false,
  ): Promise<string> {
    const done = copied.get(path)
    if (done) return done
    const target = this.freePath(path)
    copied.set(path, target)
    const bytes = await source.zip.file(path)?.async('uint8array')
    if (!bytes) throw new OfficeError(`missing part while copying: ${path}`, 'OFFICE_INVALID')
    const sourceXml = path.endsWith('.xml') ? await source.xml(path) : undefined
    if (sourceXml) {
      this.setXml(target, new DOMParser().parseFromString(new XMLSerializer().serializeToString(sourceXml), 'text/xml'))
    } else {
      this.zip.file(target, bytes)
    }
    const contentType = await source.contentTypeOf(path)
    if (contentType && contentType !== (await this.contentTypeOf(target))) await this.setContentType(target, contentType)
    for (const rel of await source.relationships(path)) {
      if (rel.external || skip(rel)) continue
      const copiedTarget = await this.copyPart(source, rel.target, copied, skip)
      await this.setRelationship(target, rel.id, rel.type, copiedTarget)
    }
    return target
  }

  /** 以固定 id 写入关系（复制部件时保持部件内部的 r:id 不变）。 */
  async setRelationship(part: string, id: string, type: string, target: string): Promise<void> {
    const document = await this.relsDocument(part)
    const existing = descendants(document, 'Relationship').find(rel => rel.getAttribute('Id') === id)
    const rel = existing ?? document.createElementNS(RELS_NS, 'Relationship')
    rel.setAttribute('Id', id)
    rel.setAttribute('Type', type)
    rel.setAttribute('Target', relativeTarget(part, target))
    if (!existing) document.documentElement?.appendChild(rel)
  }
}

/** 把一个元素（含子树）从别的文档导入到 `document`。 */
export function importInto(document: Document, element: Element): Element {
  return document.importNode(element, true)
}

/** 元素上所有引用关系的属性（`r:id`、`r:embed`、`r:link`、`r:pict`），含子树。 */
export function relationshipAttributes(root: Element): { element: Element, name: string, id: string }[] {
  const found: { element: Element, name: string, id: string }[] = []
  const visit = (element: Element): void => {
    for (const attr of Array.from(element.attributes)) {
      if (attr.namespaceURI === R_NS && attr.value) found.push({ element, name: attr.localName ?? attr.name, id: attr.value })
    }
    children(element).forEach(visit)
  }
  visit(root)
  return found
}
