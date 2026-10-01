import type { Weather } from '../lib/weather'

/**
 * Weather drawn around an avatar, in the avatar's 64-unit space. Same flat
 * language as the character: solid shapes, no outlines, a few chunky pieces
 * that still read at 16px. `back` layers sit behind the character, `front`
 * layers in front of it. Motion lives in CSS so reduced-motion can stop it.
 */
export function WeatherBack({ weather }: { weather: Weather }) {
  switch (weather) {
    case 'clear':
      return (
        <g className="wx wx-sun">
          <g className="wx-rays">
            {[0, 45, 90, 135, 180, 225, 270, 315].map(angle => (
              <rect key={angle} x="50" y="0.5" width="3" height="5" rx="1.5" transform={`rotate(${angle} 51.5 13)`} />
            ))}
          </g>
          <circle cx="51.5" cy="13" r="7.5" />
        </g>
      )
    case 'rainbow':
      return (
        <g className="wx wx-rainbow" fill="none" strokeLinecap="round" strokeWidth="4">
          <path className="band band-1" d="M4 40 A28 28 0 0 1 60 40" />
          <path className="band band-2" d="M9 40 A23 23 0 0 1 55 40" />
          <path className="band band-3" d="M14 40 A18 18 0 0 1 50 40" />
        </g>
      )
    case 'cloudy':
      return (
        <g className="wx wx-puff">
          <circle cx="50" cy="15" r="7" />
          <circle cx="57" cy="17" r="5.5" />
          <rect x="44" y="15" width="18" height="8" rx="4" />
        </g>
      )
    case 'sprite':
      return (
        <g className="wx wx-sprite" fill="none" strokeLinecap="round" strokeWidth="2.6">
          <path className="tendril t-1" d="M22 12 C21 8 23 5 21 1" />
          <path className="tendril t-2" d="M32 9 C33 5 31 2 32 -2" />
          <path className="tendril t-3" d="M42 12 C43 8 41 5 43 1" />
        </g>
      )
    default:
      return null
  }
}

const DROPS: Record<'drizzle' | 'rain' | 'sleet', Array<[number, number]>> = {
  drizzle: [[24, 0], [40, 0.45]],
  rain: [[18, 0], [28, 0.3], [38, 0.15], [48, 0.45]],
  sleet: [[20, 0], [34, 0.35], [46, 0.2]],
}

function Drop({ x, delay }: { x: number; delay: number }) {
  return <path className="drop" style={{ animationDelay: `${delay}s` }} d={`M${x} 52 c-2 3-3 4.4-3 6 a3 3 0 0 0 6 0 c0-1.6-1-3-3-6 z`} />
}

function Flake({ x, delay, y = 55 }: { x: number; delay: number; y?: number }) {
  return (
    <g className="flake" style={{ animationDelay: `${delay}s` }}>
      <rect x={x - 0.9} y={y - 4} width="1.8" height="8" rx="0.9" />
      <rect x={x - 0.9} y={y - 4} width="1.8" height="8" rx="0.9" transform={`rotate(60 ${x} ${y})`} />
      <rect x={x - 0.9} y={y - 4} width="1.8" height="8" rx="0.9" transform={`rotate(-60 ${x} ${y})`} />
    </g>
  )
}

export function WeatherFront({ weather }: { weather: Weather }) {
  switch (weather) {
    case 'drizzle':
    case 'rain':
      return <g className={`wx wx-rain wx-${weather}`}>{DROPS[weather].map(([x, delay]) => <Drop key={x} x={x} delay={delay} />)}</g>
    case 'sleet':
      return (
        <g className="wx wx-sleet">
          {DROPS.sleet.map(([x, delay], index) => index % 2 === 0
            ? <Drop key={x} x={x} delay={delay} />
            : <Flake key={x} x={x} delay={delay} />)}
        </g>
      )
    case 'snow':
      return (
        <g className="wx wx-snow">
          <Flake x={18} delay={0} />
          <Flake x={32} delay={0.6} y={58} />
          <Flake x={46} delay={0.3} />
        </g>
      )
    case 'storm':
      return (
        <g className="wx wx-storm">
          <path className="bolt" d="M35 46 L26 57 L32 57 L28 64 L39 52 L33 52 L37 46 Z" />
        </g>
      )
    case 'fog':
      return (
        <g className="wx wx-fog">
          <rect className="band band-1" x="4" y="36" width="40" height="5" rx="2.5" />
          <rect className="band band-2" x="18" y="45" width="42" height="5" rx="2.5" />
          <rect className="band band-3" x="8" y="54" width="34" height="5" rx="2.5" />
        </g>
      )
    default:
      return null
  }
}
