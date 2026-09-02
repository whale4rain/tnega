import { describe, expect, it } from 'vitest'

import { importsOnlyStdlib, parseSourceImports } from '../src/stdlib.js'

describe('stdlib import filter', () => {
  it('parses top-level import names', () => {
    expect(parseSourceImports('import math\nfrom collections import Counter\n')).toEqual([
      'math',
      'collections',
    ])
  })

  it('accepts stdlib-only sources', () => {
    expect(importsOnlyStdlib('import math', 'from collections import Counter')).toBe(true)
  })

  it('rejects third-party imports', () => {
    expect(importsOnlyStdlib('import numpy')).toBe(false)
  })
})
