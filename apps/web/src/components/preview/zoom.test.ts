import { describe, expect, it } from 'vitest'
import { fitZoom, stepZoom } from './zoom'

describe('preview zoom', () => {
  it('steps through the zoom levels and stops at the ends', () => {
    expect(stepZoom(1, 1)).toBe(1.1)
    expect(stepZoom(1, -1)).toBe(0.9)
    expect(stepZoom(0.83, 1)).toBe(0.9)
    expect(stepZoom(0.83, -1)).toBe(0.75)
    expect(stepZoom(3, 1)).toBe(3)
    expect(stepZoom(0.5, -1)).toBe(0.5)
  })

  it('fits the content width into the pane', () => {
    expect(fitZoom(700, 794)).toBe(0.88)
    expect(fitZoom(700, 700)).toBe(1)
    expect(fitZoom(100, 2000)).toBe(0.5)
    expect(fitZoom(0, 500)).toBe(1)
  })
})
