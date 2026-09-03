import { describe, expect, it } from 'vitest'

import { isBigCodeBenchEligible } from '../src/bigcodebench.js'

describe('bigcodebench eligibility', () => {
  it('accepts stdlib-only implementation and test imports', () => {
    expect(isBigCodeBenchEligible({
      libs: "['random', 'itertools']",
      test: 'import unittest\nfrom solution import *\nfrom unittest.mock import patch\n',
    })).toBe(true)
  })

  it('rejects third-party implementation libraries', () => {
    expect(isBigCodeBenchEligible({
      libs: "['numpy']",
      test: 'import unittest\nfrom solution import *\n',
    })).toBe(false)
  })

  it('rejects tests that need third-party packages', () => {
    expect(isBigCodeBenchEligible({
      libs: "['random']",
      test: 'import unittest\nfrom faker import Faker\n',
    })).toBe(false)
  })
})
