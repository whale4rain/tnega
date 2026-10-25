import type { Element } from '@xmldom/xmldom'
import { children, descendants } from './ooxml.js'

/**
 * 跨 run 的文本替换。Word 与 PowerPoint 都把一段文字拆成多个 run（格式一变就拆，
 * 有时没有可见原因），所以要在段落的拼接文本上查找，再把结果写回各个 `t` 节点：
 * 匹配的开头所在 run 承接替换文本并保留它的格式，后续被覆盖的部分从各自 run 中删去。
 */

const XML_NS = 'http://www.w3.org/XML/1998/namespace'
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

/** 段落自己的文本节点，不进入嵌套段落（例如文本框里的段落）。 */
function ownTextNodes(paragraph: Element): Element[] {
  const nodes: Element[] = []
  const walk = (element: Element): void => {
    for (const node of children(element)) {
      if (node.localName === 'p') continue
      if (node.localName === 't') nodes.push(node)
      else walk(node)
    }
  }
  walk(paragraph)
  return nodes
}

function setText(node: Element, text: string): void {
  node.textContent = text
  // Word 默认会吞掉首尾空格，必须显式保留。
  if (node.namespaceURI === W_NS) node.setAttributeNS(XML_NS, 'xml:space', 'preserve')
}

function matchesIn(text: string, find: string, matchCase: boolean): number[] {
  const haystack = matchCase ? text : text.toLowerCase()
  const needle = matchCase ? find : find.toLowerCase()
  const found: number[] = []
  for (let index = haystack.indexOf(needle); index >= 0; index = haystack.indexOf(needle, index + needle.length)) {
    found.push(index)
  }
  return found
}

/** 在一个段落里替换所有匹配，返回替换次数。 */
export function replaceInParagraph(paragraph: Element, find: string, replace: string, matchCase: boolean): number {
  if (!find) return 0
  const nodes = ownTextNodes(paragraph)
  const texts = nodes.map(node => node.textContent ?? '')
  const matches = matchesIn(texts.join(''), find, matchCase)
  // 从后往前改，前面匹配的偏移保持有效。
  for (const start of [...matches].reverse()) {
    const end = start + find.length
    let offset = 0
    let first = true
    texts.forEach((text, index) => {
      const nodeStart = offset
      const nodeEnd = offset + text.length
      offset = nodeEnd
      if (nodeEnd <= start || nodeStart >= end) return
      const before = text.slice(0, Math.max(0, start - nodeStart))
      const after = text.slice(Math.max(0, end - nodeStart))
      texts[index] = first ? `${before}${replace}${after}` : after
      first = false
    })
  }
  if (matches.length > 0) nodes.forEach((node, index) => setText(node, texts[index] ?? ''))
  return matches.length
}

/** 在一个部件根下的所有段落里替换，返回替换次数。 */
export function replaceInTree(root: Element, find: string, replace: string, matchCase: boolean): number {
  return descendants(root, 'p').reduce((count, paragraph) => count + replaceInParagraph(paragraph, find, replace, matchCase), 0)
}

export { setText }
