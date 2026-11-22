import { createContext, memo, useContext, useMemo, useSyncExternalStore } from 'react'
import { ACCENT, UMBRELLA_CANOPY, UMBRELLA_SHAFT, avatarSalt, avatarSpec, effectiveSeed, rerollAvatar, subscribeAvatars, type AvatarSpec, type Shape } from '../lib/avatar'
import { WEATHER_LABEL, type Weather } from '../lib/weather'
import { WeatherBack, WeatherFront } from './WeatherLayer'

/** Seed overrides for a group of sibling agents (see `distinctSeeds`). */
export const AvatarSeeds = createContext<Record<string, string>>({})

/**
 * A cute abstract avatar: a soft shape with two white eyes, or, for the main
 * agent (`role="coordinator"`), the brand umbrella in ink on the grey disc with
 * its eyes cut out of the canopy. `id` is the stable agent id; the same id
 * always draws the same avatar until rerolled. `weather`
 * draws the agent's state around it (see lib/weather.ts); a live avatar
 * without one is `cloudy`, i.e. thinking.
 */
export const AgentAvatar = memo(function AgentAvatar({
  id,
  role = 'agent',
  size = 28,
  live = false,
  title,
  rerollable = false,
  weather,
}: {
  id: string
  role?: 'coordinator' | 'agent'
  size?: number
  live?: boolean
  title?: string
  rerollable?: boolean
  weather?: Weather | undefined
}) {
  const salt = useSyncExternalStore(subscribeAvatars, () => avatarSalt(id), () => 0)
  const overrides = useContext(AvatarSeeds)
  const seed = overrides[id] ?? effectiveSeed(id)
  const spec = useMemo(() => avatarSpec(seed, role), [seed, role, salt])
  const sky = weather ?? (live ? 'cloudy' : undefined)
  const label = title && sky ? `${title} · ${WEATHER_LABEL[sky]}` : title
  const svg = <AvatarSvg spec={spec} size={size} live={live} title={label} weather={sky} />
  if (!rerollable) return svg
  return (
    <button type="button" className="avatar-button" onClick={() => rerollAvatar(id)} title="New look (click to reroll)" aria-label="Reroll avatar">
      {svg}
    </button>
  )
})

/** Where the eyes sit on each shape: a little above the visual centre. */
const EYE_Y: Record<Shape, number> = {
  circle: 28,
  rounded: 28,
  tilted: 28,
  gumdrop: 38,
  cloud: 32,
  drop: 40,
  umbrella: 20,
}

/** The umbrella sits inside its disc at this scale, in the brand mark's proportions. */
const UMBRELLA_ON_DISC = 'translate(32 32) scale(0.84) translate(-32 -31)'

/** Small shifts of expression that go with the weather. */
function expression(weather: Weather | undefined): { lookUp: boolean; squint: boolean; happy: boolean } {
  return { lookUp: weather === 'snow', squint: weather === 'storm', happy: weather === 'rainbow' }
}

function AvatarSvg({ spec, size, live, title, weather }: { spec: AvatarSpec; size: number; live: boolean; title?: string | undefined; weather?: Weather | undefined }) {
  const fill = spec.color === ACCENT ? 'var(--accent)' : spec.color === 'ink' ? 'var(--avatar-ink)' : spec.color
  const mood = expression(weather)
  const character = spec.shape === 'umbrella'
    ? <UmbrellaCharacter spec={spec} fill={fill} mood={mood} />
    : <ShapeCharacter spec={spec} fill={fill} mood={mood} />
  return (
    <svg
      className={`agent-avatar-svg${live ? ' is-live' : ''}${weather ? ` has-weather wx-is-${weather}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title && <title>{title}</title>}
      {weather
        ? (
          <>
            <WeatherBack weather={weather} />
            {/* The character keeps its shape; it only makes room for the sky. */}
            <g className="av-character" transform="translate(32 27) scale(0.76) translate(-32 -32)">{character}</g>
            <WeatherFront weather={weather} />
          </>
        )
        : character}
    </svg>
  )
}

function Body({ shape, rotate }: { shape: Shape; rotate: number }) {
  switch (shape) {
    case 'circle':
      return <circle cx="32" cy="32" r="28" />
    case 'rounded':
      return <rect x="6" y="6" width="52" height="52" rx="20" />
    case 'tilted':
      return <rect x="9" y="9" width="46" height="46" rx="15" transform={`rotate(${rotate} 32 32)`} />
    case 'gumdrop':
      return <path d="M32 5 C39 5 61 44 59 53 C57 61 7 61 5 53 C3 44 25 5 32 5 Z" />
    case 'cloud':
      return (
        <g>
          <circle cx="32" cy="23" r="16" />
          <circle cx="18" cy="34" r="14" />
          <circle cx="46" cy="34" r="14" />
          <circle cx="24" cy="46" r="13" />
          <circle cx="40" cy="46" r="13" />
        </g>
      )
    case 'drop':
      return <path d="M32 5 C39 15 57 27 57 40 A25 25 0 0 1 7 40 C7 27 25 15 32 5 Z" />
    case 'umbrella':
      return (
        <g>
          <path d={UMBRELLA_CANOPY} />
          <path d={UMBRELLA_SHAFT} fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
        </g>
      )
  }
}

type Mood = ReturnType<typeof expression>

function ShapeCharacter({ spec, fill, mood }: { spec: AvatarSpec; fill: string; mood: Mood }) {
  const cx = 32 + spec.gazeX
  const cy = EYE_Y[spec.shape] + (mood.lookUp ? -4 : spec.gazeY)
  const gap = spec.eyes === 'pill' ? 7 : 7.5
  const pill = mood.squint ? { h: 8, r: 3.6 } : { h: 17, r: 4.2 }
  return (
    <>
      <g className="av-body" style={{ fill }}>
        <Body shape={spec.shape} rotate={spec.rotate} />
      </g>
      {mood.happy
        ? (
          <g className="av-eyes av-eyes-happy" fill="none" stroke="#fff" strokeWidth="4.2" strokeLinecap="round">
            {[-1, 1].map(side => <path key={side} d={`M${cx + side * gap - 4.5} ${cy + 2} q4.5 -6.5 9 0`} />)}
          </g>
        )
        : (
          <g className="av-eyes" fill="#fff">
            {[-1, 1].map(side => (
              <g key={side} className="av-eye">
                {spec.eyes === 'pill'
                  ? <rect x={cx + side * gap - 4.2} y={cy - pill.h / 2} width="8.4" height={pill.h} rx={pill.r} transform={`rotate(${spec.eyeTilt} ${cx + side * gap} ${cy})`} />
                  : <circle cx={cx + side * gap} cy={cy} r={mood.squint ? 4.2 : 6} />}
              </g>
            ))}
          </g>
        )}
    </>
  )
}

/**
 * The main agent: the brand umbrella (same drawing as `--brand-umbrella` in
 * app.css) in ink on the `--disc` circle. The eyes are painted in the disc's
 * colour, so they read as cut out of the canopy. The gaze moves less than on
 * the round shapes, so the eyes stay on the canopy.
 */
function UmbrellaCharacter({ spec, fill, mood }: { spec: AvatarSpec; fill: string; mood: Mood }) {
  const cx = 32 + spec.gazeX * 0.4
  const cy = EYE_Y.umbrella + (mood.lookUp ? -3 : spec.gazeY * 0.5)
  const gap = 5.5
  const pill = mood.squint ? { h: 5, r: 2.5 } : { h: 12, r: 3 }
  return (
    <>
      <circle className="av-disc" cx="32" cy="32" r="32" fill="var(--disc)" />
      <g transform={UMBRELLA_ON_DISC}>
        <g className="av-body" style={{ fill, color: fill }}>
          <Body shape="umbrella" rotate={0} />
        </g>
        {mood.happy
          ? (
            <g className="av-eyes av-eyes-happy" fill="none" stroke="var(--disc)" strokeWidth="3.4" strokeLinecap="round">
              {[-1, 1].map(side => <path key={side} d={`M${cx + side * gap - 3.2} ${cy + 1.5} q3.2 -5 6.4 0`} />)}
            </g>
          )
          : (
            <g className="av-eyes" fill="var(--disc)">
              {[-1, 1].map(side => (
                <g key={side} className="av-eye">
                  <rect x={cx + side * gap - 3} y={cy - pill.h / 2} width="6" height={pill.h} rx={pill.r} transform={`rotate(${spec.eyeTilt * 0.4} ${cx + side * gap} ${cy})`} />
                </g>
              ))}
            </g>
          )}
      </g>
    </>
  )
}
