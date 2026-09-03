import { describe, expect, it } from 'vitest'

import { buildMbppFixture } from '../src/mbpp.js'

describe('mbpp fixture', () => {
  it('wraps asserts into unittest methods and keeps setup code', () => {
    const fixture = buildMbppFixture({
      test_list: [
        'assert add(1, 2) == 3',
        'assert add(2, 2) == 4',
      ],
      test_setup_code: 'x = 1',
    })
    expect(fixture.solution).toBe('pass\n')
    expect(fixture.test).toContain('def test_0(self):')
    expect(fixture.test).toContain('        assert add(1, 2) == 3')
    expect(fixture.test).toContain('x = 1')
    expect(fixture.test).toContain('unittest.main()')
  })

  it('handles multi-line test cases', () => {
    const fixture = buildMbppFixture({
      test_list: ['assert sum([1, 2]) == 3\nassert sum([2, 3]) == 5'],
    })
    expect(fixture.test).toContain('        assert sum([1, 2]) == 3\n        assert sum([2, 3]) == 5')
  })
})
