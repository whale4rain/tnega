import { describe, expect, it } from 'vitest'
import { fileName, officeFiles, officeKind } from './office'
import type { Block, ToolView } from './timeline'

function tool(callId: string, name: string, path: string, status: ToolView['status'] = 'ok', children?: ToolView[]): Block {
  return { kind: 'tool', id: callId, tool: { callId, name, args: { path }, status, output: { path }, ...(children ? { children } : {}) } }
}

describe('officeFiles', () => {
  it('collects successful office writes once, in last-write order, including CodeMode children', () => {
    const nested: ToolView = { callId: 'c', name: 'office_create', args: {}, status: 'ok', output: { path: 'deck.pptx' } }
    const blocks: Block[] = [
      tool('1', 'office_create', 'out/sales.xlsx'),
      tool('2', 'office_create', 'report.docx'),
      tool('3', 'office_edit', 'out/sales.xlsx'),
      tool('4', 'office_create', 'broken.xlsx', 'error'),
      tool('5', 'office_read', 'report.docx'),
      tool('6', 'write_file', 'notes.md'),
      { kind: 'tool', id: '7', tool: { callId: '7', name: 'run_code', args: {}, status: 'ok', children: [nested] } },
    ]
    expect(officeFiles(blocks)).toEqual([
      { path: 'report.docx', kind: 'docx' },
      { path: 'out/sales.xlsx', kind: 'xlsx' },
      { path: 'deck.pptx', kind: 'pptx' },
    ])
  })

  it('recognizes office extensions and file names', () => {
    expect(officeKind('A.XLSX')).toBe('xlsx')
    expect(officeKind('notes.txt')).toBeUndefined()
    expect(fileName('out/q2/sales.xlsx')).toBe('sales.xlsx')
  })
})
