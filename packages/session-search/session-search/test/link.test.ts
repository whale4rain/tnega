import { expect, it } from 'vitest'
import { formatSessionLink, parseSessionLink } from '../src/index.js'

it('round-trips a session link, including a workspace with spaces and non-ASCII names', () => {
  const ref = { workspace: '/home/me/My Projects/桌面 app+1', sessionId: '0b6f8a5e-6d3c-4c1e-9d4e-2a1b3c4d5e6f' }
  const link = formatSessionLink(ref)
  expect(link).toBe(`tnega://session/${ref.sessionId}?workspace=${encodeURIComponent(ref.workspace)}`)
  expect(parseSessionLink(link)).toEqual(ref)
  expect(parseSessionLink(`  ${link}  `)).toEqual(ref)
})

it('reads a bare id or a link without a workspace', () => {
  expect(parseSessionLink('abc')).toEqual({ sessionId: 'abc' })
  expect(parseSessionLink('tnega://session/abc')).toEqual({ sessionId: 'abc' })
  expect(parseSessionLink('')).toBeUndefined()
  expect(parseSessionLink('tnega://session/')).toBeUndefined()
})
