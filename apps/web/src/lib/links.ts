import { createContext } from 'react'

/**
 * Where a link in a reply leads. Agents link to workspace files (often as
 * `path:line`) and to the dev servers they start; both belong in the
 * Workbench, not in a new browser tab that would load the path from the UI
 * server (a 404) or leave the app for `localhost`.
 */
export type LinkTarget =
  | { kind: 'file'; path: string; line?: number }
  | { kind: 'local'; url: string }
  | { kind: 'web'; url: string }
  | { kind: 'other' }

/** What the surrounding view can open in place. */
export interface LinkHandlers {
  workspace?: string
  /** Open a workspace-relative file in the Workbench. */
  openPath?: (path: string) => void
  /** Open a local development URL in the Workbench browser. */
  openLocalUrl?: (url: string) => void
}

export const LinkContext = createContext<LinkHandlers>({})

// `app.ts:42` is a file and a line, not a scheme.
const SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d)/i
const WINDOWS_DRIVE = /^[a-z]:[\\/]/i
const LINE_SUFFIX = /(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)$/
const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[\w-]+\.localhost)$/i

export function linkTarget(href: string | undefined, workspace?: string): LinkTarget {
  const raw = href?.trim()
  if (!raw || raw.startsWith('#')) return { kind: 'other' }
  if (/^https?:/i.test(raw)) {
    try {
      const url = new URL(raw)
      return LOCAL_HOST.test(url.hostname) ? { kind: 'local', url: url.href.replace('://0.0.0.0', '://localhost') } : { kind: 'web', url: url.href }
    } catch {
      return { kind: 'other' }
    }
  }
  let path: string
  if (/^file:/i.test(raw)) {
    try {
      path = decodeURIComponent(new URL(raw).pathname).replace(/^\/([a-z]:)/i, '$1')
    } catch {
      return { kind: 'other' }
    }
  } else if (SCHEME.test(raw) && !WINDOWS_DRIVE.test(raw)) {
    return { kind: 'other' }
  } else {
    try { path = decodeURIComponent(raw) } catch { path = raw }
  }
  const match = LINE_SUFFIX.exec(path)
  const line = match ? Number(match[1] ?? match[2]) : undefined
  if (match) path = path.slice(0, match.index)
  // Any other colon is a scheme in disguise (`javascript:1;…`), not a path.
  if (path.replace(WINDOWS_DRIVE, '').includes(':')) return { kind: 'other' }
  const relative = workspaceRelative(path, workspace)
  if (relative === undefined || !relative) return { kind: 'other' }
  return { kind: 'file', path: relative, ...(line ? { line } : {}) }
}

/**
 * `src/app.ts` from an absolute or `./`-relative path; `undefined` for a path
 * outside the workspace, which the Workbench cannot open.
 */
export function workspaceRelative(path: string, workspace?: string): string | undefined {
  const normalized = path.replace(/\\/g, '/')
  const absolute = normalized.startsWith('/') || WINDOWS_DRIVE.test(normalized)
  if (!absolute) return normalized.replace(/^(?:\.\/)+/, '')
  if (!workspace) return undefined
  const root = workspace.replace(/\\/g, '/').replace(/\/+$/, '')
  const windows = WINDOWS_DRIVE.test(root)
  const inside = windows ? normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`) : normalized.startsWith(`${root}/`)
  return inside ? normalized.slice(root.length + 1) : undefined
}

/** Inline code that names a file (`apps/web/src/App.tsx`, `server.ts:42`). */
const CODE_PATH = /^(?:\.{1,2}\/)?(?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[a-z][a-z0-9]{0,7}(?::\d+(?::\d+)?)?$/i

export function codePathTarget(text: string, workspace?: string): Extract<LinkTarget, { kind: 'file' }> | undefined {
  const value = text.trim()
  if (!CODE_PATH.test(value) && !(WINDOWS_DRIVE.test(value) && !/\s/.test(value))) return undefined
  // A bare `name.ext` is too often prose (`e.g.`, `Node.js`); ask for a folder or a line.
  if (!/[\\/]/.test(value) && !/:\d+/.test(value)) return undefined
  const target = linkTarget(value, workspace)
  return target.kind === 'file' ? target : undefined
}
