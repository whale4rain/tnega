import { useEffect, useState } from 'react'
import type { SandboxSetup } from '@tnega/client/types'
import { api } from './api'
import { useStoredState } from './hooks'

/** Remembers, per browser, that the MXC install hint was dismissed. */
export const MXC_HINT_KEY = 'tnega.mxcHint'

export type MxcHintState = 'show' | 'dismissed'

/**
 * The hint appears only where it helps: Windows new enough for MXC, no
 * executor found, and the person has not dismissed it. Anywhere else the
 * existing sandbox is already the best this machine can do.
 */
export function showsMxcHint(setup: SandboxSetup | undefined, state: MxcHintState): boolean {
  return setup?.mxc === 'missing' && state !== 'dismissed'
}

/** Read the machine's sandbox setup once and pair it with the stored dismissal. */
export function useMxcHint(): { setup: SandboxSetup | undefined; visible: boolean; dismiss: () => void } {
  const [state, setState] = useStoredState<MxcHintState>(MXC_HINT_KEY, 'show', ['show', 'dismissed'])
  const [setup, setSetup] = useState<SandboxSetup>()
  useEffect(() => {
    if (state === 'dismissed') return
    const controller = new AbortController()
    // An older server has no such route; no hint is the right answer then.
    api.sandboxSetup(controller.signal).then(setSetup, () => undefined)
    return () => controller.abort()
  }, [state])
  return { setup, visible: showsMxcHint(setup, state), dismiss: () => setState('dismissed') }
}
