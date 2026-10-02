/**
 * The Workbench: one right-hand panel for everything you and the agent work
 * on — the workspace's files, its changes, a terminal, the browser — plus
 * documents and transcripts opened from the conversation. The conversation
 * is where you talk about the work; the Workbench is where the work is.
 *
 * Tools are fixed tabs; documents are closable tabs opened on demand. This
 * module is the panel's state, kept pure so App only wires it up.
 */

export type ToolId = 'files' | 'changes' | 'terminal' | 'browser'

export const TOOLS: readonly ToolId[] = ['files', 'changes', 'terminal', 'browser']

export type DocTab =
  | { key: string; kind: 'preview'; path: string }
  | { key: string; kind: 'subagent'; id: string; label: string }

/** A file to bring into view when a tool opens (a changed file, a file to edit). */
export interface Focus {
  tool: 'files' | 'changes'
  path: string
  /** Changes on every request, so focusing the same path twice still scrolls to it. */
  nonce: number
}

export interface WorkbenchState {
  open: boolean
  /** A tool id, or the `key` of an open document. */
  active: string
  docs: DocTab[]
  focus?: Focus
}

export const INITIAL_WORKBENCH: WorkbenchState = { open: false, active: 'files', docs: [] }

export function isTool(value: string): value is ToolId {
  return (TOOLS as readonly string[]).includes(value)
}

export function openTool(state: WorkbenchState, tool: ToolId, path?: string): WorkbenchState {
  const next: WorkbenchState = { ...state, open: true, active: tool }
  if (path && (tool === 'files' || tool === 'changes')) next.focus = { tool, path, nonce: (state.focus?.nonce ?? 0) + 1 }
  return next
}

/** The header button: show the panel where it was, or hide it. */
export function toggle(state: WorkbenchState): WorkbenchState {
  return { ...state, open: !state.open }
}

export type NewDoc = { kind: 'preview'; path: string } | { kind: 'subagent'; id: string; label: string }

function withKey(doc: NewDoc): DocTab {
  return doc.kind === 'preview' ? { ...doc, key: `preview:${doc.path}` } : { ...doc, key: `subagent:${doc.id}` }
}

/** Open (or return to) a document tab. The same file or transcript never opens twice. */
export function openDoc(state: WorkbenchState, doc: NewDoc): WorkbenchState {
  const tab = withKey(doc)
  const existing = state.docs.some(item => item.key === tab.key)
  return { ...state, open: true, active: tab.key, docs: existing ? state.docs : [...state.docs, tab] }
}

/** Closing the active document falls back to its left neighbour, then to the last tool. */
export function closeDoc(state: WorkbenchState, key: string, fallback: ToolId = 'files'): WorkbenchState {
  const index = state.docs.findIndex(doc => doc.key === key)
  if (index < 0) return state
  const docs = state.docs.filter(doc => doc.key !== key)
  if (state.active !== key) return { ...state, docs }
  const neighbour = docs[Math.max(0, index - 1)]
  return { ...state, docs, active: neighbour?.key ?? fallback }
}

export function select(state: WorkbenchState, key: string): WorkbenchState {
  return isTool(key) || state.docs.some(doc => doc.key === key) ? { ...state, open: true, active: key } : state
}

/** Only whether the panel is open and which tool it shows outlive a reload; documents do not. */
export function restore(saved: unknown): WorkbenchState {
  if (!saved || typeof saved !== 'object') return INITIAL_WORKBENCH
  const open = Reflect.get(saved, 'open') === true
  const active = Reflect.get(saved, 'active')
  return { open, active: typeof active === 'string' && isTool(active) ? active : 'files', docs: [] }
}

export function persisted(state: WorkbenchState): { open: boolean; active: ToolId } {
  return { open: state.open, active: isTool(state.active) ? state.active : 'files' }
}
