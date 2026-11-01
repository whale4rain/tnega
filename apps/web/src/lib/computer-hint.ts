import { useEffect, useState } from 'react'
import type { ComputerSetup } from '@tnega/client/types'
import { api } from './api'
import { useStoredState } from './hooks'

/** Remembers, per browser, that the cua-driver install hint was dismissed. */
export const COMPUTER_HINT_KEY = 'tnega.computerHint'

export type ComputerHintState = 'show' | 'dismissed'

/**
 * The hint appears only where installing the driver would actually change
 * something: the machine has no cua-driver, and the person has not dismissed it.
 *
 * It shows whether or not computer use is on, because that is the confusion it
 * exists to settle — the tools are absent when the switch is off, and they fail
 * on their first call when the driver is missing, and neither message says
 * "install this". An older server has no such route, and no hint is right then.
 */
export function showsComputerHint(setup: ComputerSetup | undefined, state: ComputerHintState): boolean {
  return setup?.driver === 'missing' && state !== 'dismissed'
}

/** Read the machine's computer setup once and pair it with the stored dismissal. */
export function useComputerHint(): { setup: ComputerSetup | undefined; visible: boolean; dismiss: () => void } {
  const [state, setState] = useStoredState<ComputerHintState>(COMPUTER_HINT_KEY, 'show', ['show', 'dismissed'])
  const [setup, setSetup] = useState<ComputerSetup>()
  useEffect(() => {
    if (state === 'dismissed') return
    const controller = new AbortController()
    api.computerSetup(controller.signal).then(setSetup, () => undefined)
    return () => controller.abort()
  }, [state])
  return { setup, visible: showsComputerHint(setup, state), dismiss: () => setState('dismissed') }
}
