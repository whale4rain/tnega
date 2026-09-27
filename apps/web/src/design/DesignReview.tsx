import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Theme } from '@astryxdesign/core/theme'
import { Stack } from '@astryxdesign/core/Stack'
import { Heading } from '@astryxdesign/core/Heading'
import { Text } from '@astryxdesign/core/Text'
import { Button } from '@astryxdesign/core/Button'
import { studioTheme } from '../workbench/theme'
import { WorkbenchShell } from '../workbench/WorkbenchShell'
import { WorkspaceSidebar } from '../workbench/WorkspaceSidebar'
import { ComposerFrame } from '../workbench/ComposerFrame'
import { MessageBlock } from '../conversation/Transcript'
import type { DisplayMessage } from '../types'
import { ProjectExperience } from '../project/ProjectExperience'
import { installProjectFixture } from './projectFixture'
import '../styles.css'

const projectReview = new URLSearchParams(location.search).has('project')
if (projectReview) installProjectFixture()

const noop = async () => {}
const workspace = '/studio/tnega'
const titles = ['Refine the agent workspace', 'Explore the event pipeline', 'Review workspace changes']
const initialMessages: DisplayMessage[] = [
  { id: 'brief', role: 'user', content: 'Give this workspace a calmer visual rhythm. Keep the tools close and the conversation easy to follow.' },
  { id: 'response', role: 'assistant', content: '## A little more room to think\n\nThe workspace now has a consistent visual language: warm graphite surfaces, a quiet green accent, and a clear reading column.\n\n### The design decisions\n\n- **Focus on the work.** Navigation stays at the edge; conversation takes the center.\n- **One coherent palette.** Messages, tools, and settings share the same surface and text tokens.\n- **Keep actions within reach.** Model, permissions, and session mode remain next to your draft.\n\nThe same system carries through to project threads, plans, and agent activity.' },
  { id: 'files', role: 'file-edits', content: '', editedFiles: [{ path: 'apps/web/src/workbench/theme.ts', additions: 48, deletions: 0 }] },
]

function DesignReview() {
  const [mode, setMode] = useState<'dark' | 'light'>('dark')
  const [draft, setDraft] = useState('')
  const [selected, setSelected] = useState('0')
  const [messages, setMessages] = useState(initialMessages)
  return <Theme theme={studioTheme} mode={mode}>
    <WorkbenchShell sidebar={<WorkspaceSidebar
      workspace={workspace} workspaces={[workspace]} selectedId={selected}
      sessions={titles.map((title, index) => ({ id: String(index), title, workspace, createdAt: 0, updatedAt: 0, eventCount: 4 }))}
      projects={projectReview ? [{ workspace, id: 'studio', name: 'The next workspace', openedAt: 1 }] : []} selectedProjectId={projectReview ? 'studio' : null} theme={mode}
      onTheme={value => setMode(value === 'light' ? 'light' : 'dark')}
      onSelect={(_, id) => setSelected(id)} onNew={async () => setMessages([])}
      onAdd={noop} onRemove={noop} onRename={noop} onFork={noop} onDelete={noop}
      onSettings={() => setMode(value => value === 'dark' ? 'light' : 'dark')}
      onOpenProject={() => {}} onNewProject={() => {}} onArchiveProject={noop} onDeleteProject={noop}
    />}>
      {projectReview ? <ProjectExperience workspace={workspace} projectId="studio" models={[{ id: 'studio', name: 'Studio model', reasoningEfforts: [] }]} model="studio" reasoningEffort="default" apiKeySet onModel={noop} onReasoningEffort={noop} onSettings={() => setMode(value => value === 'dark' ? 'light' : 'dark')} /> : <Stack className="chat" direction="vertical" gap={0}>
        <Stack direction="horizontal" className="chat-header" justify="between" align="center">
          <Stack gap={1}>
            <Heading level={3}>{titles[Number(selected)]}</Heading>
            <Text color="secondary" type="supporting">Studio design review · local sample content</Text>
          </Stack>
          <Button label={mode === 'dark' ? 'Light appearance' : 'Dark appearance'} variant="ghost" size="sm" onClick={() => setMode(mode === 'dark' ? 'light' : 'dark')} />
        </Stack>
        <Stack className="messages-viewport">
          <Stack className="conversation-scroll" gap={0}>
            <Stack className="messages" gap={8}>
              {messages.map(message => <MessageBlock key={message.id} message={message} />)}
              {!messages.length && <Heading level={2}>What are we building?</Heading>}
            </Stack>
            <Stack className="composer-surface" gap={3}>
              <ComposerFrame
                value={draft} onChange={setDraft} canSend={!!draft.trim()} disabled={false}
                onSubmit={() => { if (draft.trim()) { setMessages(items => [...items, { id: String(Date.now()), role: 'user', content: draft }]); setDraft('') } }}
                model="studio" models={[{ id: 'studio', name: 'Studio model', reasoningEfforts: ['low', 'medium', 'high'] }]}
                reasoningEffort="high" onModel={noop} onReasoningEffort={noop}
                apiKeySet permission="workspace-write" onPermission={() => {}} mode="auto" onMode={noop} onSettings={() => {}}
                placeholder="Describe the next step…"
              />
              <Stack className="conversation-footer" direction="horizontal" justify="between">
                <Text color="secondary" type="supporting">Visual sample · no model requests</Text>
                <Text color="secondary" type="supporting">Tnega Studio</Text>
              </Stack>
            </Stack>
          </Stack>
        </Stack>
      </Stack>}
    </WorkbenchShell>
  </Theme>
}

const root = document.getElementById('root')
if (!root) throw new Error('missing design review root')
createRoot(root).render(<DesignReview />)

