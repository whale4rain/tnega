/**
 * How a running Agent Run streams into view: every step and thought as it
 * happens, or one progress line until the turn ends and the answer lands.
 * A per-device display preference like palette and density (design §6.2), but
 * it changes how much of the process is shown, so it is not a token attribute.
 */
import { useStoredState } from './hooks'

export type ProcessView = 'steps' | 'answer'

export const PROCESS_VIEW_KEY = 'tnega.processView'

/** Defaults to streaming the process; the dropdown only appears while a turn runs. */
export function useProcessView(): [ProcessView, (value: ProcessView) => void] {
  return useStoredState<ProcessView>(PROCESS_VIEW_KEY, 'steps', ['steps', 'answer'])
}
