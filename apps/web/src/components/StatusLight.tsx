import type { LightTone } from '../lib/project-model'
import { PenMark, type PenKind } from './PenMark'

/** Which hand-drawn mark stands for each light (tnega-design §3.9, §5.7). */
const PEN: Record<LightTone, PenKind> = { waiting: 'you', failed: 'failed', working: 'working', ready: 'done', idle: 'idle' }

/**
 * A thread's, project's or session's status as a hand-drawn mark: a loop around a dot when it
 * waits on you, a cross when it failed, a half-hatched circle while it works, a tick for a result
 * you have not opened, a thin ring otherwise. The label is its accessible name and tooltip.
 */
export function StatusLight({ tone, label, size = 14 }: { tone: LightTone; label: string; size?: number }) {
  return (
    <span className={`status-light light-${tone}`} role="img" aria-label={label} title={label}>
      <PenMark kind={PEN[tone]} size={size} />
    </span>
  )
}
