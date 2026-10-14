import { stripVTControlCharacters } from 'node:util'
import type { Weather } from '@tnega/client'
import { WEATHER_LABEL } from '@tnega/client'
import { renderToString, Text } from 'ink'
import { describe, expect, it } from 'vitest'
import { cloudRows, HeaderCloud, SKY, skyFrame, STRIP_WIDTH, WeatherStrip } from '../src/weather.js'
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

describe('header cloud', () => {
  it('is the brand cloud with two eyes, five rows tall', () => {
    const rows = cloudRows().map(text)
    expect(rows).toHaveLength(5)
    expect(rows[2]).toMatch(/██ ██ ██/u)
  })

  it('sets the lines beside it', () => {
    const out = stripVTControlCharacters(renderToString(<HeaderCloud lines={<Text>tnega</Text>} />, { columns: 60 }))
    expect(out).toContain('tnega')
    expect(out).toContain('█')
  })
})
