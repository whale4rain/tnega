/**
 * The weather in pictures: a short animated strip beside the status label
 * while the agent works, and the brand cloud drawn in half-block pixels at
 * the top of a session. The strip never adds a row; the cloud is printed
 * once and never moves.
 */
import type { Weather } from '@tnega/client'
import { Box, Text, useAnimation } from 'ink'
import type { ReactNode } from 'react'
import { reducedMotion } from './spinner.js'

/** One coloured run of characters. */
export interface Segment {
  text: string
  color?: string
  backgroundColor?: string
}

/** Cells every strip takes, so the label after it never shifts. */
export const STRIP_WIDTH = 6

const BLUE = 'blueBright'
const CYAN = 'cyanBright'
const WHITE = 'whiteBright'
const GRAY = 'gray'
const YELLOW = 'yellowBright'
const MAGENTA = 'magentaBright'
const ORANGE = 'ansi256(214)'

const run = (text: string, color: string): Segment => ({ text, color })

/** Frames per weather; each frame is STRIP_WIDTH cells wide. */
export const SKY: Record<Weather, readonly Segment[][]> = {
  clear: [[run('●', YELLOW)]],
  cloudy: [
    [run('░', GRAY), run('▒▓', WHITE), run('▒░', GRAY)],
    [run('░▒', GRAY), run('▓▒', WHITE), run('░', GRAY)],
    [run('░▒▓', GRAY), run('▒░', WHITE)],
    [run('░', GRAY), run('▒▓', WHITE), run('▒░', GRAY)],
  ],
  drizzle: [
    [run('▘ ', BLUE), run('▗  ', CYAN), run('▝', BLUE)],
    [run(' ▗ ', CYAN), run('▘ ▗', BLUE)],
  ],
  rain: [
    [run('▚', BLUE), run('▞', CYAN), run('▚', BLUE), run('▞', CYAN), run('▚', BLUE), run('▞', CYAN)],
    [run('▞', CYAN), run('▚', BLUE), run('▞', CYAN), run('▚', BLUE), run('▞', CYAN), run('▚', BLUE)],
  ],
  snow: [
    [run('✱ ', WHITE), run('• ', CYAN), run('✱ ', WHITE)],
    [run(' • ', CYAN), run('✱ ', WHITE), run('•', CYAN)],
  ],
  sleet: [
    [run('▘', BLUE), run('✱', WHITE), run('▗', BLUE), run('•', WHITE), run('▘', BLUE), run('✱', WHITE)],
    [run('✱', WHITE), run('▝', BLUE), run('•', WHITE), run('▖', BLUE), run('✱', WHITE), run('▝', BLUE)],
  ],
  storm: [
    [run('↯', YELLOW), run('▗▘', BLUE), run('↯', YELLOW), run('▗▘', BLUE)],
    [run('▘▗', BLUE), run('↯', YELLOW), run('▘▗', BLUE), run('↯', YELLOW)],
  ],
  fog: [
    [run('▬', GRAY), run('▬', WHITE), run('▬ ▬', GRAY), run('▬', WHITE)],
    [run('▬', WHITE), run('▬ ▬', GRAY), run('▬', WHITE), run('▬', GRAY)],
  ],
  rainbow: [[run('▀', 'redBright'), run('▀', ORANGE), run('▀', YELLOW), run('▀', 'greenBright'), run('▀', BLUE), run('▀', MAGENTA)]],
  sprite: [
    [run('▖', MAGENTA), run('▝ ', CYAN), run('▖', MAGENTA), run('▝ ', CYAN)],
    [run(' ▝', CYAN), run('▖ ', MAGENTA), run('▝', CYAN), run('▖', MAGENTA)],
  ],
}

/** Weathers that move: something is happening right now. */
const MOVING: ReadonlySet<Weather> = new Set(['cloudy', 'drizzle', 'rain', 'snow', 'sleet', 'storm', 'fog', 'sprite'])

/** The label's colour, matching its strip. */
export function weatherTone(weather: Weather): string | undefined {
  switch (weather) {
    case 'drizzle':
    case 'rain':
      return BLUE
    case 'snow':
    case 'fog':
    case 'sleet':
      return 'yellow'
    case 'storm':
      return 'red'
    case 'rainbow':
      return 'green'
    case 'sprite':
      return MAGENTA
    default:
      return undefined
  }
}

/** One frame padded to STRIP_WIDTH cells; the idle sun stays a single mark. */
export function skyFrame(weather: Weather, frame: number): Segment[] {
  const frames = SKY[weather]
  const segments = frames[frame % frames.length] ?? []
  const width = segments.reduce((sum, segment) => sum + segment.text.length, 0)
  return width < STRIP_WIDTH && weather !== 'clear' ? [...segments, { text: ' '.repeat(STRIP_WIDTH - width) }] : segments
}

export function WeatherStrip({ weather }: { weather: Weather }) {
  const moving = MOVING.has(weather) && !reducedMotion
  const { frame } = useAnimation({ interval: 400, isActive: moving })
  return <Text><Segments segments={skyFrame(weather, moving ? frame : 0)} /></Text>
}

function Segments({ segments }: { segments: readonly Segment[] }) {
  return (
    <>
      {segments.map((segment, index) => (
        <Text key={index} {...(segment.color ? { color: segment.color } : {})} {...(segment.backgroundColor ? { backgroundColor: segment.backgroundColor } : {})}>
          {segment.text}
        </Text>
      ))}
    </>
  )
}

/** The brand cloud (apps/desktop/build/icon.svg) at 10 × 8 pixels; the gaps are its eyes. */
const CLOUD = [
  '...####...',
  '..######..',
  '.########.',
  '###.##.###',
  '###.##.###',
  '.########.',
  '.########.',
  '..######..',
]

type Pixel = 'cloud' | 'sun' | undefined

const SUN = { x: 12, y: 3, r: 2.7 }
const CANVAS = { width: 15, height: 10 }

function pixel(x: number, y: number): Pixel {
  const row = CLOUD[y - 1]
  if (row?.[x - 1] === '#') return 'cloud'
  if ((x - SUN.x) ** 2 + (y - SUN.y) ** 2 <= SUN.r ** 2) return 'sun'
  return undefined
}

/**
 * The cloud with the sun behind it, two pixels per cell. The cloud takes the
 * terminal's own foreground so it reads on light and dark themes; where a
 * cell holds both, the cloud wins.
 */
export function cloudRows(): Segment[][] {
  const rows: Segment[][] = []
  for (let y = 0; y < CANVAS.height; y += 2) {
    const row: Segment[] = []
    for (let x = 0; x < CANVAS.width; x += 1) {
      const top = pixel(x, y)
      const bottom = pixel(x, y + 1)
      const cell = cellFor(top, bottom)
      const last = row.at(-1)
      if (last && last.color === cell.color) last.text += cell.text
      else row.push(cell)
    }
    rows.push(row)
  }
  return rows
}

function cellFor(top: Pixel, bottom: Pixel): Segment {
  if (top === 'cloud' || bottom === 'cloud') {
    const text = top === 'cloud' && bottom === 'cloud' ? '█' : top === 'cloud' ? '▀' : '▄'
    return { text }
  }
  if (top === 'sun' && bottom === 'sun') return { text: '█', color: 'yellow' }
  if (top === 'sun') return { text: '▀', color: 'yellow' }
  if (bottom === 'sun') return { text: '▄', color: 'yellow' }
  return { text: ' ' }
}

/** Cells the header cloud takes, gap included. */
export const CLOUD_WIDTH = CANVAS.width + 2

export function HeaderCloud({ lines }: { lines: ReactNode }) {
  const rows = cloudRows()
  return (
    <Box flexDirection="row">
      <Box flexDirection="column" width={CLOUD_WIDTH} flexShrink={0}>
        {rows.map((row, index) => <Text key={index}><Segments segments={row} /></Text>)}
      </Box>
      <Box flexDirection="column" justifyContent="center">
        {lines}
      </Box>
    </Box>
  )
}
