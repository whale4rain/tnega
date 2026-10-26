import { DOMParser, type Document, type Element } from '@xmldom/xmldom'
import JSZip from 'jszip'
import { OfficeError } from './errors.js'

/** OOXML（docx / pptx）只读访问：zip 包 + 按 localName 遍历的 XML，不关心命名空间前缀。 */

export async function openPackage(bytes: Uint8Array, kind: string): Promise<JSZip> {
  try {
    return await JSZip.loadAsync(bytes)
  } catch (error) {
    throw new OfficeError(`not a readable ${kind} file`, 'OFFICE_INVALID', { cause: error })
  }
}

export async function readXml(zip: JSZip, path: string): Promise<Document | undefined> {
  const file = zip.file(path)
  if (!file) return undefined
  return new DOMParser().parseFromString(await file.async('string'), 'text/xml')
}

export async function requireXml(zip: JSZip, path: string, kind: string): Promise<Document> {
  const document = await readXml(zip, path)
  if (!document) throw new OfficeError(`not a ${kind} file: missing ${path}`, 'OFFICE_INVALID')
  return document
}

/** 直接子元素，可按 localName 过滤。 */
export function children(parent: Element, localName?: string): Element[] {
  const result: Element[] = []
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (isElement(node) && (localName === undefined || node.localName === localName)) {
      result.push(node)
    }
  }
  return result
}

function isElement(node: { nodeType: number }): node is Element {
  return node.nodeType === 1
}

export function child(parent: Element, localName: string): Element | undefined {
  return children(parent, localName)[0]
}

/** 所有后代元素（文档序），按 localName 过滤。 */
export function descendants(parent: Element | Document, localName: string): Element[] {
  return Array.from(parent.getElementsByTagNameNS('*', localName))
}

/** 按 localName 取属性，忽略前缀（`w:val`、`r:id` 等）。 */
export function attribute(element: Element | undefined, localName: string): string | undefined {
  if (!element) return undefined
  for (const attr of Array.from(element.attributes)) {
    if (attr.localName === localName) return attr.value
  }
  return undefined
}

const RELATIONSHIP_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

/** 引用关系的 `r:id` 属性；同一元素上常有同名的数字 `id`，所以必须按命名空间取。 */
export function relationshipId(element: Element | undefined): string | undefined {
  return element?.getAttributeNS(RELATIONSHIP_NS, 'id') || undefined
}

/** 关系文件：`rId` → 目标路径（相对 `base` 目录解析）。 */
export async function relationships(zip: JSZip, relsPath: string, base: string): Promise<Map<string, string>> {
  const document = await readXml(zip, relsPath)
  const map = new Map<string, string>()
  if (!document) return map
  for (const rel of descendants(document, 'Relationship')) {
    const id = attribute(rel, 'Id')
    const target = attribute(rel, 'Target')
    if (id && target) map.set(id, resolvePart(base, target))
  }
  return map
}

function resolvePart(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = base.split('/').filter(Boolean)
  for (const segment of target.split('/')) {
    if (segment === '..') parts.pop()
    else if (segment !== '.') parts.push(segment)
  }
  return parts.join('/')
}
