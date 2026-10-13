import { describe, expect, it } from 'vitest'
import * as edit from '../src/editor.js'

const at = (text: string, caret = text.length): edit.EditorState => ({ text, caret })

describe('composer editing', () => {
  it('moves and deletes a Chinese character or an emoji as one unit', () => {
    expect(edit.backspace(at('你好'))).toEqual(at('你'))
    expect(edit.backspace(at('ok👍🏽'))).toEqual(at('ok'))
    expect(edit.left(at('a你'))).toEqual(at('a你', 1))
    expect(edit.right(at('👨‍👩‍👧x', 0)).caret).toBe('👨‍👩‍👧'.length)
    expect(edit.deleteForward(at('你好', 0))).toEqual(at('好', 0))
  })

  it('keeps the display column when moving between lines of wide text', () => {
    // Caret after "你好" (4 cells) on line 2 lands after "abcd" on line 1.
    const state = at('abcdef\n你好世界', 'abcdef\n你好'.length)
    expect(edit.up(state).caret).toBe(4)
    expect(edit.down(edit.up(state)).caret).toBe('abcdef\n你好'.length)
    expect(edit.caretPosition(state)).toEqual({ row: 1, column: 4 })
  })

  it('inserts pasted text with one newline style and no tabs', () => {
    expect(edit.insert(at(''), 'a\r\nb\tc')).toEqual(at('a\nb  c'))
  })

  it('deletes words and line halves like a shell', () => {
    expect(edit.deleteWord(at('git commit -m'))).toEqual(at('git commit '))
    expect(edit.deleteToLineStart(at('one\ntwo three'))).toEqual(at('one\n'))
    expect(edit.deleteToLineEnd(at('one two', 3))).toEqual(at('one', 3))
  })

  it('walks sent prompts and restores the unsent draft', () => {
    const history = new edit.History()
    history.push('first')
    history.push('second')
    expect(history.previous('draft')).toBe('second')
    expect(history.previous('second')).toBe('first')
    expect(history.previous('first')).toBeUndefined()
    expect(history.next()).toBe('second')
    expect(history.next()).toBe('draft')
    expect(history.next()).toBeUndefined()
  })
})
