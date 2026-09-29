import { createContext, memo, useContext, useMemo, useSyncExternalStore } from 'react'
import { ACCENT, avatarSalt, avatarSpec, effectiveSeed, rerollAvatar, subscribeAvatars, type AvatarSpec, type Shape } from '../lib/avatar'

/** Seed overrides for a group of sibling agents (see `distinctSeeds`). */
export const AvatarSeeds = createContext<Record<string, string>>({})

/**
 * A cute abstract avatar: a soft shape with two white eyes. `id` is the stable
 * agent id; the same id always draws the same avatar until rerolled.
 */
export const AgentAvatar = memo(function AgentAvatar({
  id,
  role = 'agent',
  size = 28,
  live = false,
  title,
  rerollable = false,
}: {
  id: string
  role?: 'coordinator' | 'agent'
  size?: number
  live?: boolean
  title?: string
  rerollable?: boolean
}) {
  const salt = useSyncExternalStore(subscribeAvatars, () => avatarSalt(id), () => 0)
  const overrides = useContext(AvatarSeeds)
  const seed = overrides[id] ?? effectiveSeed(id)
  const spec = useMemo(() => avatarSpec(seed, role), [seed, role, salt])
  const svg = <AvatarSvg spec={spec} size={size} live={live} title={title} />
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
}

function AvatarSvg({ spec, size, live, title }: { spec: AvatarSpec; size: number; live: boolean; title?: string | undefined }) {
  const fill = spec.color === ACCENT ? 'var(--accent)' : spec.color === 'ink' ? 'var(--avatar-ink)' : spec.color
  const cx = 32 + spec.gazeX
  const cy = EYE_Y[spec.shape] + spec.gazeY
  const gap = spec.eyes === 'pill' ? 7 : 7.5
  return (
    <svg
      className={`agent-avatar-svg${live ? ' is-live' : ''}`}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title && <title>{title}</title>}
      <g className="av-body" style={{ fill }}>
        <Body shape={spec.shape} rotate={spec.rotate} />
      </g>
      <g className="av-eyes" fill="#fff">
        {[-1, 1].map(side => (
          <g key={side} className="av-eye">
            {spec.eyes === 'pill'
              ? <rect x={cx + side * gap - 4.2} y={cy - 8.5} width="8.4" height="17" rx="4.2" transform={`rotate(${spec.eyeTilt} ${cx + side * gap} ${cy})`} />
              : <circle cx={cx + side * gap} cy={cy} r="6" />}
          </g>
        ))}
      </g>
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
  }
}
