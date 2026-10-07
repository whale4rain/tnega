import { describe, expect, it } from 'vitest'
import { BOARD_KEY, closeDoc, enterProject, INITIAL_WORKBENCH, openDoc, openTool, persisted, restore, select, toggle } from './workbench'

describe('workbench state', () => {
  it('opens tools, focusing a path for files and changes', () => {
    const first = openTool(INITIAL_WORKBENCH, 'changes', 'src/a.ts')
    expect(first).toMatchObject({ open: true, active: 'changes', focus: { tool: 'changes', path: 'src/a.ts', nonce: 1 } })
    const again = openTool(first, 'changes', 'src/a.ts')
    expect(again.focus?.nonce).toBe(2)
    expect(openTool(again, 'terminal').focus).toEqual(again.focus)
    expect(toggle(again).open).toBe(false)
    expect(toggle(toggle(again))).toMatchObject({ open: true, active: 'changes' })
  })

  it('opens each document once and closes back to a neighbour', () => {
    let state = openDoc(INITIAL_WORKBENCH, { kind: 'preview', path: 'report.docx' })
    state = openDoc(state, { kind: 'subagent', id: 'a1', label: 'Research' })
    state = openDoc(state, { kind: 'preview', path: 'report.docx' })
    expect(state.docs.map(doc => doc.key)).toEqual(['preview:report.docx', 'subagent:a1'])
    expect(state.active).toBe('preview:report.docx')

    state = select(state, 'subagent:a1')
    state = closeDoc(state, 'subagent:a1')
    expect(state.active).toBe('preview:report.docx')
    state = closeDoc(state, 'preview:report.docx', 'browser')
    expect(state).toMatchObject({ active: 'browser', docs: [] })
    expect(select(state, 'subagent:gone')).toBe(state)
  })

  it('remembers only the open flag and a tool across reloads', () => {
    const state = openDoc(openTool(INITIAL_WORKBENCH, 'terminal'), { kind: 'preview', path: 'a.pdf' })
    expect(persisted(state)).toEqual({ open: true, active: 'files' })
    expect(persisted(openTool(state, 'terminal'))).toEqual({ open: true, active: 'terminal' })
    expect(restore({ open: true, active: 'terminal' })).toEqual({ open: true, active: 'terminal', docs: [] })
    expect(restore({ open: 'yes', active: 'nope' })).toEqual(INITIAL_WORKBENCH)
    expect(restore(null)).toEqual(INITIAL_WORKBENCH)
  })
})

describe('workbench in a project', () => {
  it('opens one exchange tab for either direction and removes it when leaving a project', () => {
    const first = openDoc(INITIAL_WORKBENCH, { kind: 'exchange', firstId: 'c', secondId: 'a', label: 'C ↔ A' })
    const again = openDoc(first, { kind: 'exchange', firstId: 'a', secondId: 'c', label: 'A ↔ C' })
    expect(again.docs).toHaveLength(1)
    expect(again.active).toBe(first.active)
    expect(closeDoc(again, again.active, BOARD_KEY).active).toBe(BOARD_KEY)
    expect(enterProject(again, undefined, 'p')).toMatchObject({ docs: [], active: 'files' })
  })
  it('shows the Board when entering a project and drops another project\'s threads', () => {
    let state = openDoc(INITIAL_WORKBENCH, { kind: 'preview', path: 'a.docx' })
    state = enterProject(state, 'p1', undefined)
    expect(state).toMatchObject({ open: true, active: BOARD_KEY })
    state = openDoc(state, { kind: 'thread', id: 't1', label: 'Compare' })
    expect(state.active).toBe('thread:t1')
    // Re-entering the same project keeps the open thread.
    expect(enterProject(state, 'p1', 'p1')).toBe(state)
    const other = enterProject(state, 'p2', 'p1')
    expect(other.docs.map(doc => doc.key)).toEqual(['preview:a.docx'])
    expect(other.active).toBe(BOARD_KEY)
  })

  it('leaves project tabs behind when going back to sessions', () => {
    let state = enterProject(INITIAL_WORKBENCH, 'p1', undefined)
    state = openDoc(state, { kind: 'settings', label: 'Settings' })
    state = enterProject(state, undefined, 'p1')
    expect(state.docs).toEqual([])
    expect(state.active).toBe('files')
  })

  it('selects project tabs, keeps thread labels current and closes threads back to the Board', () => {
    let state = enterProject(INITIAL_WORKBENCH, 'p1', undefined)
    state = select(state, 'project:routines')
    expect(state.active).toBe('project:routines')
    state = openDoc(state, { kind: 'thread', id: 't1', label: 'Draft' })
    state = openDoc(state, { kind: 'thread', id: 't1', label: 'Draft notes' })
    expect(state.docs.map(doc => doc.kind === 'thread' && doc.label)).toEqual(['Draft notes'])
    state = closeDoc(state, 'thread:t1', BOARD_KEY)
    expect(state.active).toBe(BOARD_KEY)
  })
})
