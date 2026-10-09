import type { LightTone } from '../lib/project-model'

/**
 * A small status light for a thread or project: amber when it waits on you,
 * red when it failed, pulsing accent while it works, green for a result you
 * have not opened. The label is its accessible name and tooltip.
 */
export function StatusLight({ tone, label }: { tone: LightTone; label: string }) {
  return <span className={`status-light light-${tone}`} role="img" aria-label={label} title={label} />
}
