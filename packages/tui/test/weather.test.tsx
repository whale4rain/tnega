import { stripVTControlCharacters } from 'node:util'
import type { Weather } from '@tnega/client'
import { WEATHER_LABEL } from '@tnega/client'
import { renderToString, Text } from 'ink'
import { describe, expect, it } from 'vitest'
import { HeaderUmbrella, SKY, skyFrame, STRIP_WIDTH, umbrellaRows, WeatherStrip, weatherMark, weatherTone } from '../src/weather.js'
import { stringWidth } from '../src/width.js'

const weathers = Object.keys(WEATHER_LABEL) as Weather[]
const text = (segments: { text: string }[]) => segments.map(segment => segment.text).join('')

describe('weather strip', () => {
  it('has a picture for every weather, each frame the same width', () => {
    expect(text(skyFrame('clear', 0))).toBe('●')
    for (const weather of weathers.filter(weather => weather !== 'clear')) {
      expect(SKY[weather].length).toBeGreaterThan(0)
      for (let frame = 0; frame < SKY[weather].length; frame += 1) {
        expect(stringWidth(text(skyFrame(weather, frame))), `${weather} frame ${frame}`).toBe(STRIP_WIDTH)
      }
    }
  })

  it('draws rain in blue', () => {
    const out = renderToString(<WeatherStrip weather="rain" />, { columns: 20 })
    expect(stripVTControlCharacters(out)).toBe('▚▞▚▞▚▞')
    expect(skyFrame('rain', 0).map(segment => segment.color)).toContain('blueBright')
  })
})

describe('status mark', () => {
  it('says whose turn it is in the hand-mark vocabulary', () => {
    expect(weatherMark('snow')).toBe('you')
    expect(weatherMark('rain')).toBe('working')
    expect(weatherMark('cloudy')).toBe('working')
    expect(weatherMark('rainbow')).toBe('done')
    expect(weatherMark('storm')).toBe('failed')
    expect(weatherMark('clear')).toBe('idle')
  })

  it('keeps the label in ink except for a failure', () => {
    for (const weather of weathers.filter(weather => weather !== 'storm')) expect(weatherTone(weather), weather).toBeUndefined()
    expect(weatherTone('storm')).toBe('red')
  })
})

describe('header umbrella', () => {
  it('is the brand umbrella with two eyes, six rows tall', () => {
    const rows = umbrellaRows()
    expect(rows).toHaveLength(6)
    expect(rows[0]!.trim()).toBe('▄▄█▄▄')
    // Two eyes cut out of the canopy, and the hooked handle at the bottom.
    expect(rows[2]).toMatch(/█ ███ █/u)
    expect(rows[5]).toMatch(/▀▄▄▀/u)
  })

  it('has no colour and sets the lines beside it', () => {
    const raw = renderToString(<HeaderUmbrella lines={<Text>tnega</Text>} />, { columns: 60 })
    expect(raw).not.toContain('\u001b[3')
    const out = stripVTControlCharacters(raw)
    expect(out).toContain('tnega')
    expect(out).toContain('█')
  })
})
