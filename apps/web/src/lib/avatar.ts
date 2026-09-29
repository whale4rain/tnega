/**
 * Cute abstract agent avatars: one soft, chunky shape in a bold flat colour
 * with two white eyes. Character comes from the shape, the eye style and
 * where the eyes look. Nothing else.
 *
 * Every agent id maps to a stable avatar; the coordinator is an accent
 * circle. Users can reroll an avatar; the choice is a salt in localStorage.
 */

export type Shape = 'circle' | 'rounded' | 'tilted' | 'gumdrop' | 'cloud' | 'drop'
export type EyeStyle = 'pill' | 'dot'

export interface AvatarSpec {
  shape: Shape
  /** Solid fill; `accent` means the theme accent colour. */
  color: string
  eyes: EyeStyle
  /** Where the eyes look, in viewBox units. */
  gazeX: number
  gazeY: number
  /** Tilt of pill eyes, in degrees. */
  eyeTilt: number
  /** Rotation of the body (used by the tilted square). */
  rotate: number
}

export const COLORS: readonly string[] = [
  'ink', // near-black; lightens in dark mode
  '#ff6a13', // orange
  '#15b3a2', // teal
  '#8b5cf6', // violet
  '#1f7ae0', // blue
  '#ff3d9a', // pink
  '#ffa21b', // amber
  '#9a6b43', // cocoa
  '#6e7781', // slate
  '#22a45d', // green
]

export const ACCENT = 'accent'

export const SHAPES: readonly Shape[] = ['circle', 'rounded', 'tilted', 'gumdrop', 'cloud', 'drop']

/** FNV-1a: a tiny, stable string hash. */
export function hash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** mulberry32: deterministic PRNG from a 32-bit seed. */
function random(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(next: () => number, items: readonly T[]): T {
  return items[Math.floor(next() * items.length)]!
}

function between(next: () => number, min: number, max: number): number {
  return Math.round((min + next() * (max - min)) * 2) / 2
}

export function avatarSpec(seed: string, role: 'coordinator' | 'agent' = 'agent'): AvatarSpec {
  const next = random(hash(`${role}:${seed}`))
  const coordinator = role === 'coordinator'
  const shape: Shape = coordinator ? 'circle' : pick(next, SHAPES)
  return {
    shape,
    color: coordinator ? ACCENT : pick(next, COLORS),
    eyes: next() < 0.62 ? 'pill' : 'dot',
    gazeX: between(next, -5, 5),
    gazeY: between(next, -3, 1),
    eyeTilt: between(next, -14, 14),
    rotate: shape === 'tilted' ? (next() < 0.5 ? -1 : 1) * between(next, 10, 18) : 0,
  }
}

// ---------------------------------------------------------------------------
// Rerolls, remembered per agent id
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'tnega.avatars'
const listeners = new Set<() => void>()
let salts: Record<string, number> | undefined
let version = 0

function load(): Record<string, number> {
  if (salts) return salts
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    salts = parsed && typeof parsed === 'object' ? parsed as Record<string, number> : {}
  } catch {
    salts = {}
  }
  return salts
}

export function avatarSalt(id: string): number {
  return load()[id] ?? 0
}

export function rerollAvatar(id: string): void {
  const next = { ...load(), [id]: avatarSalt(id) + 1 }
  salts = next
  version += 1
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Rerolls are cosmetic; losing them is fine.
  }
  for (const listener of listeners) listener()
}

export function subscribeAvatars(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Changes whenever any avatar is rerolled; use to recompute derived seeds. */
export function avatarVersion(): number {
  return version
}

/** The seed actually used for an agent, after any rerolls. */
export function effectiveSeed(id: string): string {
  const salt = avatarSalt(id)
  return salt ? `${id}#${salt}` : id
}

/**
 * Seeds for a group of sibling agents (in creation order) so no two share the
 * colour: a clash moves the later agent to its next variant.
 */
export function distinctSeeds(ids: readonly string[], coordinatorId?: string): Record<string, string> {
  const colors = new Set<string>()
  const looks = new Set<string>()
  const seeds: Record<string, string> = {}
  for (const id of ids) {
    const role = id === coordinatorId ? 'coordinator' : 'agent'
    const base = effectiveSeed(id)
    let seed = base
    for (let attempt = 1; attempt <= 40; attempt += 1) {
      const spec = avatarSpec(seed, role)
      const look = `${spec.shape}/${spec.color}`
      // Prefer a colour no sibling has; once all are taken, at least a new shape and colour pair.
      const clash = colors.size < COLORS.length ? colors.has(spec.color) : looks.has(look)
      if (!clash || attempt === 40) {
        colors.add(spec.color)
        looks.add(look)
        break
      }
      seed = `${base}~${attempt}`
    }
    seeds[id] = seed
  }
  return seeds
}
