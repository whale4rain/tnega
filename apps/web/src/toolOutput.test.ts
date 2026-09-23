import { describe, expect, it } from 'vitest'
import { MAX_RENDERED_CHARS, boundedText, readSpillNotice } from './toolOutput'

/**
 * The exact notice `@tnega/tool-spill` produces, pins the format the reader
 * above depends on. If the producer's wording changes, this test is where the
 * web side finds out.
 */
const NOTICE =
  '\n\n(Omitted 14129 bytes. Full formatted result stored at: '
  + '.tnega/spill/big-call_1-big.txt. Read it with the read_file tool '
  + '(raise maxBytes or use offset/limit for a specific window), '
  + 'or grep this path to search inside it.)'

describe('spill notice recognition', () => {
  it('splits a notice from the preview it follows', () => {
    const notice = readSpillNotice(`head\n…\ntail${NOTICE}`)
    expect(notice).toEqual({
      preview: 'head\n…\ntail',
      omittedBytes: 14_129,
      locator: '.tnega/spill/big-call_1-big.txt',
      retrievalHint:
        'Read it with the read_file tool (raise maxBytes or use offset/limit '
        + 'for a specific window), or grep this path to search inside it.',
    })
  })

  it('ignores text that only looks like a notice', () => {
    expect(readSpillNotice('ordinary tool output')).toBeUndefined()
    // The wording alone is not a notice: it has to close the output.
    expect(readSpillNotice(`preview${NOTICE}\nand then more`)).toBeUndefined()
  })
})

describe('bounded text', () => {
  it('passes short text through untouched', () => {
    expect(boundedText('short')).toEqual({
      text: 'short',
      truncated: false,
      totalChars: 5,
    })
  })

  it('keeps a prefix and reports the full length', () => {
    const long = 'x'.repeat(MAX_RENDERED_CHARS + 10)
    const bounded = boundedText(long)
    expect(bounded.text).toHaveLength(MAX_RENDERED_CHARS)
    expect(bounded.truncated).toBe(true)
    expect(bounded.totalChars).toBe(MAX_RENDERED_CHARS + 10)
  })
})
