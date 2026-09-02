import { describe, expect, it } from 'vitest'

import { buildHumanEvalFixture } from '../src/humaneval.js'

describe('humaneval fixture', () => {
  it('keeps prompt with a pass stub and wraps the check call', () => {
    const fixture = buildHumanEvalFixture({
      prompt: 'def has_close_elements(numbers, threshold):\n    """doc"""\n',
      test: 'def check(candidate):\n    assert candidate([1.0], 0.5) is True\n',
      entry_point: 'has_close_elements',
    })
    expect(fixture.solution).toContain('    pass\n')
    expect(fixture.solution).not.toContain('assert')
    expect(fixture.test).toContain('check(has_close_elements)')
    expect(fixture.test).toContain('unittest.main()')
  })
})
