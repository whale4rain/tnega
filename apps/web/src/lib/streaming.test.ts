import { describe, expect, it } from 'vitest'
import { nextRevealLength, settleMarkdown } from './streaming'

describe('settleMarkdown', () => {
  it('drops an unclosed bold marker at the start of a heading line', () => {
    expect(settleMarkdown('**How')).toBe('How')
  })

  it('keeps closed bold and drops only the dangling one', () => {
    expect(settleMarkdown('**Canopy** keeps **rain')).toBe('**Canopy** keeps rain')
  })

  it('drops a dangling inline code tick', () => {
    expect(settleMarkdown('run `sh date')).toBe('run sh date')
  })

  it('closes an open code fence and leaves its content alone', () => {
    expect(settleMarkdown('Here:\n\n```ts\nconst a = **b')).toBe('Here:\n\n```ts\nconst a = **b\n```')
  })

  it('leaves a closed fence and the text after it as written', () => {
    const text = '```\ncode\n```\n\nDone **now**'
    expect(settleMarkdown(text)).toBe(text)
  })

  it('keeps list bullets', () => {
    expect(settleMarkdown('- one\n- two')).toBe('- one\n- two')
    expect(settleMarkdown('* one\n* tw')).toBe('* one\n* tw')
  })

  it('hides a table row until its separator arrives', () => {
    expect(settleMarkdown('Parts:\n\n| Part | Use')).toBe('Parts:')
    const table = 'Parts:\n\n| Part | Use |\n| --- | --- |\n| Canopy'
    expect(settleMarkdown(table)).toBe(table)
  })

  it('keeps the words of a link whose target has not arrived', () => {
    expect(settleMarkdown('See [the docs](https://exa')).toBe('See the docs')
    expect(settleMarkdown('See [the do')).toBe('See the do')
    expect(settleMarkdown('See [the docs](https://example.com) now')).toBe('See [the docs](https://example.com) now')
  })

  it('does not touch underscores inside words', () => {
    expect(settleMarkdown('use write_file and')).toBe('use write_file and')
  })
})

describe('nextRevealLength', () => {
  it('moves at least one character a frame', () => {
    expect(nextRevealLength(10, 11, 1)).toBe(11)
    expect(nextRevealLength(10, 200, 0)).toBe(11)
  })

  it('drains a burst within about the catch-up time', () => {
    let shown = 0
    let frames = 0
    while (shown < 600 && frames < 100) { shown = nextRevealLength(shown, 600, 16); frames++ }
    expect(shown).toBe(600)
    expect(frames).toBeLessThan(60)
  })

  it('never passes the target', () => {
    expect(nextRevealLength(5, 6, 1000)).toBe(6)
    expect(nextRevealLength(8, 6, 16)).toBe(6)
  })
})
