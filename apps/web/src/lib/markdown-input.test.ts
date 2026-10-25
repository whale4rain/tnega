import { expect, it } from 'vitest'
import { continueList, indentList, markdownTokens } from './markdown-input'

it('carries a numbered list on with the next number', () => {
  const text = 'Plan:\n1. first'
  expect(continueList(text, text.length)).toEqual({ text: 'Plan:\n1. first\n2. ', caret: text.length + 4 })
  expect(continueList('9) last', 7)).toEqual({ text: '9) last\n10) ', caret: 12 })
})

it('carries bullets, nesting and task boxes on', () => {
  expect(continueList('- a', 3)?.text).toBe('- a\n- ')
  expect(continueList('  * nested', 10)?.text).toBe('  * nested\n  * ')
  expect(continueList('- [x] done', 10)?.text).toBe('- [x] done\n- [ ] ')
})

it('ends the list on an empty item and leaves other lines alone', () => {
  expect(continueList('1. a\n2. ', 8)).toEqual({ text: '1. a\n', caret: 5 })
  expect(continueList('just text', 9)).toBeUndefined()
  // A selection, or the caret inside the marker, is a plain newline.
  expect(continueList('- a', 0, 3)).toBeUndefined()
  expect(continueList('- a', 1)).toBeUndefined()
})

it('nests and lifts list items with Tab and Shift+Tab', () => {
  expect(indentList('- a\n- b', 7, 7, false)).toEqual({ text: '- a\n  - b', caret: 9 })
  expect(indentList('- a\n  - b', 9, 9, true)).toEqual({ text: '- a\n- b', caret: 7 })
  expect(indentList('1. a\n2. b', 9, 9, false)?.text).toBe('1. a\n  1. b')
  expect(indentList('plain', 2, 2, false)).toBeUndefined()
})

it('splits text into pieces that join back to exactly the text', () => {
  const text = '# Title\n1. **bold** and `code`\n> quote\n```\nconst a_b = 1\n```\nsnake_case_name *em*'
  const tokens = markdownTokens(text)
  expect(tokens.map(token => token.text).join('')).toBe(text)
  expect(tokens.find(token => token.kind === 'marker')?.text).toBe('1. ')
  expect(tokens.filter(token => token.kind === 'code').map(token => token.text)).toEqual(['`code`', 'const a_b = 1'])
  expect(tokens.find(token => token.kind === 'strong')?.text).toBe('bold')
  expect(tokens.find(token => token.kind === 'heading')?.text).toBe('Title')
  // Underscores inside a word are not emphasis.
  expect(tokens.some(token => token.text === 'case')).toBe(false)
})
