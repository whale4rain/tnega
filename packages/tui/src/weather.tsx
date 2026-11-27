/**
 * The weather in pictures: a short animated strip beside the status label
 * while the agent works, and the brand umbrella drawn in half-block pixels
 * at the top of a session. The strip never adds a row; the umbrella is
 * printed once and never moves.
 */
import type { Weather } from '@tnega/client'
import { Box, Text, useAnimation } from 'ink'
import type { ReactNode } from 'react'
import { reducedMotion } from './spinner.js'
import { color, type Mark } from './theme.js'

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

/**
 * The hand mark beside the status label: whose turn it is, in the same
 * vocabulary as the web app (design guide §3.9). The strip says what the
 * agent is doing; the mark says whether that is yours to act on.
 */
export function weatherMark(weather: Weather): Mark {
  switch (weather) {
    case 'snow':
      return 'you'
    case 'storm':
      return 'failed'
    case 'rainbow':
      return 'done'
    case 'cloudy':
    case 'drizzle':
    case 'rain':
    case 'sleet':
    case 'sprite':
      return 'working'
    default:
      return 'idle'
  }
}

/** The label stays ink; only a failure takes the error colour. */
export function weatherTone(weather: Weather): string | undefined {
  return weather === 'storm' ? color.danger : undefined
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

/**
 * The brand umbrella (design guide §2) at 15 × 12 pixels: tip, canopy with
 * a scalloped hem, shaft and hook. The two gaps in the canopy are its eyes.
 */
const UMBRELLA = [
  '.......#.......',
  '.....#####.....',
  '...#########...',
  '..###########..',
  '.####.###.####.',
  '#####.###.#####',
  '###############',
  '#..#..###..#..#',
  '.......#.......',
  '.......#.......',
  '.......#..#....',
  '........##.....',
]

const CANVAS = { width: UMBRELLA[0]!.length, height: UMBRELLA.length }

function inked(x: number, y: number): boolean {
  return UMBRELLA[y]?.[x] === '#'
}

/**
 * The umbrella two pixels per cell, in the terminal's own foreground: ink
 * on whatever ground the terminal has, light or dark, with no colour.
 */
export function umbrellaRows(): string[] {
  const rows: string[] = []
  for (let y = 0; y < CANVAS.height; y += 2) {
    let row = ''
    for (let x = 0; x < CANVAS.width; x += 1) {
      const top = inked(x, y)
      const bottom = inked(x, y + 1)
      row += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' '
    }
    rows.push(row)
  }
  return rows
}

/** Cells the header umbrella takes, gap included. */
export const UMBRELLA_WIDTH = CANVAS.width + 2

export function HeaderUmbrella({ lines }: { lines: ReactNode }) {
  return (
    <Box flexDirection="row">
      <Box flexDirection="column" width={UMBRELLA_WIDTH} flexShrink={0}>
        {umbrellaRows().map((row, index) => <Text key={index}>{row}</Text>)}
      </Box>
      <Box flexDirection="column" justifyContent="center">
        {lines}
      </Box>
    </Box>
  )
}
