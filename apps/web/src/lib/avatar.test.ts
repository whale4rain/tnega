import { describe, expect, it } from 'vitest'
import { avatarSpec, COLORS, COORDINATOR_COLORS, distinctSeeds, effectiveSeed, SHAPES } from './avatar'

describe('avatarSpec', () => {
  it('is stable for an id and varies across ids', () => {
    expect(avatarSpec('thread-a')).toEqual(avatarSpec('thread-a'))
    const specs = Array.from({ length: 60 }, (_, i) => avatarSpec(`agent-${i}`))
    expect(new Set(specs.map(s => s.shape)).size).toBe(6)
    expect(new Set(specs.map(s => s.color)).size).toBeGreaterThan(7)
    for (const spec of specs) {
      expect(SHAPES).toContain(spec.shape)
      expect(COLORS).toContain(spec.color)
    }
  })

  it('draws every coordinator as a cloud, in a colour that tells projects apart', () => {
    const colors = new Set<string>()
    for (let i = 0; i < 20; i += 1) {
      const spec = avatarSpec(`project-${i}`, 'coordinator')
      expect(spec.shape).toBe('cloud')
      expect(COORDINATOR_COLORS).toContain(spec.color)
      colors.add(spec.color)
    }
    expect(colors.size).toBeGreaterThanOrEqual(5)
  })

  it('uses the plain id until rerolled', () => {
    expect(effectiveSeed('fresh-id')).toBe('fresh-id')
  })
})

describe('distinctSeeds', () => {
  it('keeps the first agent as is and gives the first ten siblings ten different colours', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `sibling-${i}`)
    const seeds = distinctSeeds(ids)
    expect(seeds[ids[0]!]).toBe(ids[0])
    const colors = ids.slice(0, 10).map(id => avatarSpec(seeds[id]!).color)
    expect(new Set(colors).size).toBe(10)
    const looks = ids.map(id => { const s = avatarSpec(seeds[id]!); return `${s.shape}/${s.color}` })
    expect(new Set(looks).size).toBe(ids.length)
    expect(distinctSeeds(ids)).toEqual(seeds)
  })
})
