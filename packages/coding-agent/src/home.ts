import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Shared per-user runtime root, including skills and Session state. */
export function resolveTnegaHome(): string {
  const configured = process.env.TNEGA_HOME?.trim()
  if (!configured) return join(homedir(), '.tnega')
  if (configured === '~') return homedir()
  if (configured.startsWith('~/') || configured.startsWith('~\\')) return join(homedir(), configured.slice(2))
  return resolve(configured)
}
