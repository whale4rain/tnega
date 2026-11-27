import { Text, useAnimation } from 'ink'
import { mark, WORKING_FRAMES } from './theme.js'

/**
 * Terminals have no `prefers-reduced-motion`; `TNEGA_REDUCED_MOTION=1`
 * stands in for it and stills every spinner.
 */
export const reducedMotion = /^(1|true|yes|on)$/i.test(process.env['TNEGA_REDUCED_MOTION'] ?? '')

/** The working hand mark, turning while something runs; still under reduced motion. */
export function Spinner({ color }: { color?: string | undefined }) {
  const { frame } = useAnimation({ interval: 160, isActive: !reducedMotion })
  return <Text {...(color ? { color } : {})}>{reducedMotion ? mark.working : WORKING_FRAMES[frame % WORKING_FRAMES.length]}</Text>
}
