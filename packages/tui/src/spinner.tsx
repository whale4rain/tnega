import { Text, useAnimation } from 'ink'
import { SPINNER } from './theme.js'

/**
 * Terminals have no `prefers-reduced-motion`; `TNEGA_REDUCED_MOTION=1`
 * stands in for it and stills every spinner.
 */
export const reducedMotion = /^(1|true|yes|on)$/i.test(process.env['TNEGA_REDUCED_MOTION'] ?? '')

export function Spinner({ color }: { color?: string | undefined }) {
  const { frame } = useAnimation({ interval: 90, isActive: !reducedMotion })
  return <Text {...(color ? { color } : {})}>{reducedMotion ? '•' : SPINNER[frame % SPINNER.length]}</Text>
}
