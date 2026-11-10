import { createContext, useContext } from 'react'
import type { AuthSession } from './types'

/**
 * Who is signed in, on a tnega server that asks people to sign in.
 * `undefined` on a local host, which has no accounts.
 */
export const AccountContext = createContext<AuthSession | undefined>(undefined)

export function useAccount(): AuthSession | undefined {
  return useContext(AccountContext)
}

/** Owners and admins run the server: models, approvals, tools and people. */
export function runsServer(session: AuthSession | undefined): boolean {
  return session === undefined || session.account.role !== 'member'
}

/** A short name for this browser in the person's device list. */
export function deviceName(agent: string = navigator.userAgent): string {
  const browser = /Edg\//u.test(agent) ? 'Edge' : /Firefox\//u.test(agent) ? 'Firefox' : /Chrome\//u.test(agent) ? 'Chrome' : /Safari\//u.test(agent) ? 'Safari' : 'Browser'
  const system = /Windows/u.test(agent) ? 'Windows' : /Mac OS X/u.test(agent) ? 'macOS' : /Android/u.test(agent) ? 'Android' : /iPhone|iPad/u.test(agent) ? 'iOS' : /Linux/u.test(agent) ? 'Linux' : ''
  return system ? `${browser} on ${system}` : browser
}

/** The invite code in the page address (`/?invite=…`), from a link `tnega server invite` printed. */
export function inviteFromLocation(search: string = location.search): string | undefined {
  const code = new URLSearchParams(search).get('invite')?.trim()
  return code || undefined
}
