import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

function fakeAudio() {
  const tones: Array<{ frequency: number; start: number; stop: number }> = []
  const peaks: number[] = []
  class FakeContext {
    currentTime = 1
    state = 'suspended'
    destination = {}
    resumed = 0
    resume() { this.resumed += 1; return Promise.resolve() }
    createOscillator() {
      const tone = { type: '', frequency: { value: 0 }, start: 0, stop: 0 }
      return {
        get type() { return tone.type }, set type(value: string) { tone.type = value },
        frequency: tone.frequency,
        connect: () => undefined,
        start: (at: number) => { tone.start = at },
        stop: (at: number) => { tone.stop = at; tones.push({ frequency: tone.frequency.value, start: tone.start, stop: at }) },
      }
    }
    createGain() {
      return {
        gain: { setValueAtTime: () => undefined, linearRampToValueAtTime: (value: number) => { peaks.push(value) }, exponentialRampToValueAtTime: () => undefined },
        connect: () => undefined,
      }
    }
  }
  const created: FakeContext[] = []
  vi.stubGlobal('AudioContext', class extends FakeContext { constructor() { super(); created.push(this) } })
  return { tones, peaks, created }
}

it('plays two quiet notes, rising for a reply and falling for a failure, from one shared context', async () => {
  const { tones, peaks, created } = fakeAudio()
  const { playChime } = await import('./chime')
  playChime('completed')
  const fundamentals = tones.filter((_, index) => index % 2 === 0)
  expect(fundamentals.map(tone => Math.round(tone.frequency))).toEqual([784, 1047])
  expect(fundamentals[1]!.start).toBeGreaterThan(fundamentals[0]!.start)
  expect(Math.max(...peaks)).toBeLessThanOrEqual(0.05)

  tones.length = 0
  playChime('failed')
  const falling = tones.filter((_, index) => index % 2 === 0).map(tone => tone.frequency)
  expect(falling[0]).toBeGreaterThan(falling[1]!)
  expect(created).toHaveLength(1)
  expect(created[0]!.resumed).toBe(2)
})

it('stays silent without Web Audio', async () => {
  vi.stubGlobal('AudioContext', undefined)
  const { playChime } = await import('./chime')
  expect(() => playChime('waiting')).not.toThrow()
})
