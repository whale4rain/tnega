// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it } from 'vitest'
import { fromSnapshot } from '../../lib/project-model'
import type { BoxEnvelope, ProjectSnapshot } from '../../lib/project-types'
import { ExchangePanel } from './ExchangePanel'

afterEach(cleanup)

it('shows both authors and consecutive separate bubbles in the selected Agent conversation', () => {
  const base = { projectId: 'p', placement: { kind: 'thread' as const, threadId: 'writer' }, refs: [] }
  const messages: BoxEnvelope[] = [
    { ...base, messageId: 'a', sender: { kind: 'agent', id: 'c' }, recipients: [{ kind: 'agent', id: 'writer' }], kind: 'dispatch', text: 'Write the draft.', createdAt: 1 },
    { ...base, messageId: 'b', sender: { kind: 'agent', id: 'c' }, recipients: [{ kind: 'agent', id: 'writer' }], kind: 'dispatch', text: 'Use the revised brief.', createdAt: 2 },
    { ...base, messageId: 'd', sender: { kind: 'agent', id: 'writer' }, recipients: [{ kind: 'agent', id: 'c' }], kind: 'complete', text: 'Draft is ready.', createdAt: 3 },
    { ...base, messageId: 'e', sender: { kind: 'agent', id: 'other' }, recipients: [{ kind: 'agent', id: 'writer' }], kind: 'progress', text: 'Other pair.', createdAt: 4 },
  ]
  const snapshot: ProjectSnapshot = {
    project: { id: 'p', name: 'Launch', coordinatorId: 'c', createdAt: 1, updatedAt: 1 }, coordinatorId: 'c', cursor: 1,
    threads: [{ id: 'writer', projectId: 'p', parentId: 'c', label: 'Content Writer', goal: 'Write', state: 'done', depth: 1, permission: 'read-only', createdAt: 1, updatedAt: 1 }],
    messages: [], inboxMessages: [], agentMessages: messages, memory: [], library: { artifacts: [], resources: [] },
  }
  const view = render(createElement(ExchangePanel, { state: fromSnapshot(snapshot), workspace: '/repo', firstId: 'c', secondId: 'writer', onOpenThread: () => {}, onClose: () => {} }))
  const log = view.getByRole('log', { name: 'Agent conversation' })
  expect(log.querySelectorAll('.room-run')).toHaveLength(2)
  expect(log.querySelectorAll('.room-message')).toHaveLength(3)
  expect(log.querySelectorAll('.room-author')[0]?.textContent).toBe('Coordinator')
  expect(log.querySelectorAll('.room-author')[1]?.textContent).toBe('Content Writer')
  expect(view.queryByText('Other pair.')).toBeNull()
  expect(view.getByRole('button', { name: 'Open Content Writer' })).toBeTruthy()
})
