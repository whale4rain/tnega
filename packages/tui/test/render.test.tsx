import { stripVTControlCharacters } from 'node:util'
import type { Entry } from '@tnega/client'
import { renderToString } from 'ink'
import { describe, expect, it } from 'vitest'
import { Markdown } from '../src/markdown.js'
import { EntryView, tailRows } from '../src/transcript.js'
import { diffLines } from '../src/views.js'
import { stringWidth, truncate } from '../src/width.js'

const strip = (text: string) => stripVTControlCharacters(text)

describe('markdown in the terminal', () => {
  it('aligns table columns by cell width, so Chinese text lines up', () => {
    const out = strip(renderToString(<Markdown text={'| 文件 | 大小 |\n| --- | --- |\n| 说明.md | 14 B |\n| a.ts | 19 B |'} width={60} />, { columns: 60 }))
    const column = (size: string) => {
      const row = out.split('\n').find(line => line.includes(size))!
      return stringWidth(row.slice(0, row.indexOf(size)))
    }
    expect(column('14 B')).toBe(column('19 B'))
  })

  it('draws lists, code and inline styles without markup characters', () => {
    const out = strip(renderToString(<Markdown text={'Use **bold** and `code`:\n\n- one\n- two\n\n```ts\nconst x = 1\n```'} width={40} />, { columns: 40 }))
    expect(out).toContain('Use bold and code:')
    expect(out).toContain('• one')
    expect(out).toContain('│ ts')
    expect(out).toContain('│ const x = 1')
    expect(out).not.toContain('**')
  })
})

describe('transcript', () => {
  const turn: Entry = {
    kind: 'agent',
    id: 'a',
    status: 'done',
    summary: { text: 'All set.', sourceMessageId: 'm2' },
    blocks: [
      { kind: 'text', id: 'm1', text: 'Looking around.' },
      { kind: 'tool', id: 't1', tool: { callId: 't1', name: 'read_file', args: { path: 'a.ts' }, status: 'ok', durationMs: 20 } },
      { kind: 'text', id: 'm2', text: 'All set.' },
    ],
  }

  it('folds a finished turn to its answer and a count of the steps', () => {
    const out = strip(renderToString(<EntryView entry={turn} width={60} />, { columns: 60 }))
    expect(out).toContain('Used 1 tool · Ctrl+O to show')
    expect(out).toContain('All set.')
    expect(out).not.toContain('Looking around.')
  })

  it('shows every step with Ctrl+O', () => {
    const out = strip(renderToString(<EntryView entry={turn} width={60} verbose />, { columns: 60 }))
    expect(out).toContain('Looking around.')
    expect(out).toContain('✓ Read a.ts  20ms')
  })

  it('keeps only the newest rows of a long streaming reply', () => {
    expect(tailRows('1\n2\n3\n4', 10, 2)).toBe('3\n4')
    // A 30-cell Chinese line wraps to three rows at width 10.
    expect(tailRows(`short\n${'字'.repeat(15)}`, 10, 3)).toBe('字'.repeat(15))
  })
})

describe('helpers', () => {
  it('truncates by terminal cells', () => {
    expect(truncate('你好世界', 5)).toBe('你好…')
    expect(stringWidth(truncate('你好世界', 5))).toBeLessThanOrEqual(5)
  })

  it('turns both sides of a file into diff lines', () => {
    const lines = diffLines({ path: 'a.ts', status: 'modified', original: 'a\nb\n', modified: 'a\nc\n' })
    expect(lines.map(line => line.kind)).toEqual(['hunk', 'same', 'del', 'add'])
    expect(diffLines({ path: 'x.png', status: 'added', reason: 'binary' })[0]?.text).toBe('Binary file')
  })
})
