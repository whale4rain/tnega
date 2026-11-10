import { useEffect, useState, type ReactNode } from 'react'
import { api, ApiError } from '../lib/api'
import { AccountContext, inviteFromLocation } from '../lib/account'
import type { AuthSession } from '../lib/types'
import { SignIn } from './SignIn'

type Gate =
  | { kind: 'checking' }
  /** A local host: no accounts, nothing to sign in to. */
  | { kind: 'local' }
  | { kind: 'signed-in'; session: AuthSession }
  | { kind: 'sign-in' }

/**
 * Asks the server who is signed in before the app loads. A local host has no
 * sign-in route (404) and goes straight on; a server answers 401 until
 * someone signs in, and the sign-in page (or the invite form, for a link
 * with `?invite=`) comes first.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [gate, setGate] = useState<Gate>({ kind: 'checking' })
  const [invite, setInvite] = useState(() => inviteFromLocation())

  const check = () => {
    api.authSession().then(
      session => setGate({ kind: 'signed-in', session }),
      reason => setGate(reason instanceof ApiError && reason.status === 401 ? { kind: 'sign-in' } : { kind: 'local' }),
    )
  }
  useEffect(check, [])

  if (gate.kind === 'checking') return <div className="splash"><span className="brand-mark large pulse" aria-hidden /></div>
  if (gate.kind === 'sign-in' || (gate.kind === 'signed-in' && invite)) {
    // Signed in already and opening an invite: the invite is for someone else, so sign in as them.
    return <SignIn invite={invite} onSignedIn={() => {
      if (invite) {
        // The code is spent; keep it out of the address and the history.
        history.replaceState(null, '', location.pathname + location.hash)
        setInvite(undefined)
      }
      setGate({ kind: 'checking' })
      check()
    }} />
  }
  return <AccountContext.Provider value={gate.kind === 'signed-in' ? gate.session : undefined}>{children}</AccountContext.Provider>
}
