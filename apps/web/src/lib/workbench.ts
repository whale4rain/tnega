/**
 * The Workbench: one right-hand panel for everything you and the agent work
 * on — the workspace's files, its changes, a terminal, the browser — plus
 * documents and transcripts opened from the conversation. The conversation
 * is where you talk about the work; the Workbench is where the work is.
 *
 * Tools are fixed tabs; documents are closable tabs opened on demand. This
 * module is the panel's state, kept pure so App only wires it up.
 *
 * In a Project the same panel leads with the project's own tabs — Board,
 * Library, Routines — and opens threads and project settings as closable
 * tabs, so the project screen behaves like a session's.
 */

export type ToolId = 'files' | 'changes' | 'terminal' | 'browser'

export const TOOLS: readonly ToolId[] = ['files', 'changes', 'terminal', 'browser']

export type ProjectTabId = 'board' | 'library' | 'routines'

export const PROJECT_TABS: readonly ProjectTabId[] = ['board', 'library', 'routines']

export function projectTabKey(tab: ProjectTabId): string {
  return `project:${tab}`
}

export const BOARD_KEY = projectTabKey('board')

export type DocTab =
  | { key: string; kind: 'preview'; path: string }
  | { key: string; kind: 'subagent'; id: string; label: string }
  | { key: string; kind: 'thread'; id: string; label: string }
  | { key: string; kind: 'exchange'; firstId: string; secondId: string; label: string }
  | { key: string; kind: 'settings'; label: string }

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

export function isProjectTab(value: string): boolean {
  return PROJECT_TABS.some(tab => projectTabKey(tab) === value)
}

/** Tabs that only exist inside a project: its fixed tabs, its threads and its settings. */
export function isProjectKey(value: string): boolean {
  return isProjectTab(value) || value.startsWith('thread:') || value.startsWith('exchange:') || value === 'project-settings'
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

export type NewDoc =
  | { kind: 'preview'; path: string }
  | { kind: 'subagent'; id: string; label: string }
  | { kind: 'thread'; id: string; label: string }
  | { kind: 'exchange'; firstId: string; secondId: string; label: string }
  | { kind: 'settings'; label: string }

function withKey(doc: NewDoc): DocTab {
  switch (doc.kind) {
    case 'preview': return { ...doc, key: `preview:${doc.path}` }
    case 'subagent': return { ...doc, key: `subagent:${doc.id}` }
    case 'thread': return { ...doc, key: `thread:${doc.id}` }
    case 'exchange': return { ...doc, key: `exchange:${[doc.firstId, doc.secondId].sort().join(':')}` }
    case 'settings': return { ...doc, key: 'project-settings' }
  }
}

/** Open (or return to) a document tab. The same file or transcript never opens twice. */
export function openDoc(state: WorkbenchState, doc: NewDoc): WorkbenchState {
  const tab = withKey(doc)
  const existing = state.docs.find(item => item.key === tab.key)
  // A thread can be renamed while its tab is open; keep the label current.
  const docs = existing
    ? state.docs.map(item => (item.key === tab.key ? tab : item))
    : [...state.docs, tab]
  return { ...state, open: true, active: tab.key, docs }
}

/** Show a project tab (Board, Library, Routines). */
export function openProjectTab(state: WorkbenchState, tab: ProjectTabId): WorkbenchState {
  return { ...state, open: true, active: projectTabKey(tab) }
}

/**
 * Entering a project: drop another project's threads and show the Board.
 * Leaving it (`projectId` undefined): drop project tabs and fall back to a tool.
 */
export function enterProject(state: WorkbenchState, projectId: string | undefined, previous: string | undefined): WorkbenchState {
  const docs = state.docs.filter(doc => doc.kind === 'preview' || doc.kind === 'subagent')
  if (!projectId) {
    return { ...state, docs, active: isProjectKey(state.active) ? 'files' : state.active }
  }
  if (projectId === previous) return state
  return { ...state, docs, open: true, active: BOARD_KEY }
}

/** Closing the active document falls back to its left neighbour, then to the given tab. */
export function closeDoc(state: WorkbenchState, key: string, fallback: string = 'files'): WorkbenchState {
  const index = state.docs.findIndex(doc => doc.key === key)
  if (index < 0) return state
  const docs = state.docs.filter(doc => doc.key !== key)
  if (state.active !== key) return { ...state, docs }
  const neighbour = docs[Math.max(0, index - 1)]
  return { ...state, docs, active: neighbour?.key ?? fallback }
}

export function select(state: WorkbenchState, key: string): WorkbenchState {
  return isTool(key) || isProjectTab(key) || state.docs.some(doc => doc.key === key) ? { ...state, open: true, active: key } : state
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
