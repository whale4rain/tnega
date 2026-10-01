import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'
import { replaceInTree } from '../src/text-edit.js'

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

function run(xml: string, find: string, replace: string, matchCase = true): { count: number, xml: string } {
  const document = new DOMParser().parseFromString(xml, 'text/xml')
  const root = document.documentElement
  if (!root) throw new Error('no root')
  const count = replaceInTree(root, find, replace, matchCase)
  return { count, xml: new XMLSerializer().serializeToString(document) }
}

describe('replaceInTree', () => {
  it('replaces text split across runs and keeps the first run formatting', () => {
    const { count, xml } = run(`<w:body ${W}><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Q2 Sa</w:t></w:r><w:r><w:t>les grew</w:t></w:r></w:p></w:body>`, 'Sales', 'Revenue')
    expect(count).toBe(1)
    expect(xml).toContain('<w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Q2 Revenue</w:t>')
    expect(xml).toContain('<w:t xml:space="preserve"> grew</w:t>')
  })

  it('replaces every match, case-insensitively when asked, and leaves other paragraphs alone', () => {
    const { count, xml } = run(`<w:body ${W}><w:p><w:r><w:t>Acme and ACME</w:t></w:r></w:p><w:p><w:r><w:t>none</w:t></w:r></w:p></w:body>`, 'acme', 'Globex', false)
    expect(count).toBe(2)
    expect(xml).toContain('Globex and Globex')
    expect(xml).toContain('<w:t>none</w:t>')
  })

  it('works on DrawingML paragraphs without adding xml:space', () => {
    const { count, xml } = run('<p:sp xmlns:p="p" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>Old </a:t></a:r><a:r><a:t>title</a:t></a:r></a:p></p:sp>', 'Old title', 'New title')
    expect(count).toBe(1)
    expect(xml).toContain('<a:t>New title</a:t><')
    expect(xml).not.toContain('xml:space')
  })
})
