import { URL } from 'node:url'

/** Durable, deliberately short messages: fixtures exercise the real App, not a component harness. */
export const workspace = 'D:/fixture/workspace'
const at = Date.now() - 60_000
export const project = { id: 'project', name: 'Writing site', coordinatorId: 'coordinator', createdAt: at, updatedAt: at }
export const threads = ['coordinator', 'writer', 'research'].map((id, index) => ({
  id, projectId: project.id, label: ['Coordinator', 'Content Writer', 'Research'][index],
  goal: ['Coordinate the project.', 'Write the beginner guide.', 'Review the brief.'][index],
  state: index === 2 ? 'waiting' : 'idle', depth: index ? 1 : 0, ...(index ? { parentId: 'coordinator' } : {}),
  permission: 'read-only', createdAt: at, updatedAt: at,
}))
function message(id, sender, recipients, kind, text, offset, placement = { kind: 'main' }) {
  return { messageId: id, projectId: project.id, sender: { kind: sender === 'user' ? 'user' : 'agent', id: sender },
    recipients: recipients.map(id => ({ kind: id === 'user' ? 'user' : 'agent', id })), kind, text, placement, refs: [], createdAt: at + offset }
}
const messages = [
  message('user-1', 'user', ['coordinator'], 'user-message', 'Build a focused writing site.', 0),
  message('reply-1', 'coordinator', ['user'], 'agent-reply', 'I’ll split the work into two focused tasks.', 1000),
  message('reply-2', 'coordinator', ['user'], 'agent-reply', 'The brief is ready in docs/brief.md.', 2000),
  message('reply-3', 'coordinator', ['user'], 'agent-reply', 'Read the [reference site](https://example.com). Preview at http://localhost:4173.', 3000),
  message('reply-4', 'coordinator', ['user'], 'agent-reply', 'I’ve shared the brief with [Content Writer](#thread:writer) and [Research](#thread:research).', 7000),
]
const communications = [
  message('dispatch-1', 'coordinator', ['writer', 'research'], 'dispatch', 'Use the brief. Keep the scope small.', 4000),
  message('dispatch-2', 'coordinator', ['writer'], 'request', 'Please remove hardware topics.', 5000),
  message('writer-1', 'writer', ['coordinator'], 'progress', 'Draft ready. See docs/brief.md.', 6000),
  message('writer-research', 'writer', ['research'], 'request', 'PRIVATE PAIR: Please review the headings.', 8000),
]
export const lateMessage = message('late-1', 'writer', ['coordinator'], 'progress', 'The shorter draft is ready.', 9000)
export const snapshot = { project, coordinatorId: 'coordinator', cursor: 10, threads, messages,
  inboxMessages: [communications[2]], agentMessages: communications, threadMessages: [
    message('thread-user', 'user', ['writer'], 'user-thread', 'Use short headings.', 10000, { kind: 'thread', threadId: 'writer' }),
    message('thread-reply', 'writer', ['user'], 'agent-reply', 'Done. The headings are shorter.', 11000, { kind: 'thread', threadId: 'writer' }),
  ], memory: [], library: { artifacts: [], resources: [] }, routines: [] }
export const totals = { responses: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, activeMs: 0 }
export const config = { effective: { baseUrl: '', model: 'fixture', modelId: 'fixture' },
  config: { apiKeySet: true, path: 'fixture.json', models: [] }, env: { apiKeySet: false }, models: [], apiKeySet: true }
export const session = { id: 'session-fixture', title: 'Short general chat', workspace, createdAt: at, updatedAt: at,
  eventCount: 2, agentType: 'general', mode: 'auto', permission: 'read-only', approvalMode: 'manual' }
const sessionEvents = [
  { id: 'session-user', seq: 1, ts: at, type: 'user/message', payload: { content: 'Review docs/brief.md and the [user reference](https://example.com/user).' } },
  { id: 'session-agent', seq: 2, ts: at + 1000, type: 'assistant/message', payload: { content: 'Done. See docs/brief.md and the [agent reference](https://example.com/agent).' } },
]

/** Unknown routes are errors, so new app requests require an explicit fixture. */
export async function installFixtures(context) {
  const unexpected = []
  const navigation = []
  const streamCursors = []
  let deliverLate = false
  let delivered = false
  let longHistory = false
  await context.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()
    const json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    if (path === '/api/projects/project/stream' && method === 'GET') {
      streamCursors.push(Number(url.searchParams.get('after')))
      if (deliverLate) delivered = true
      const events = deliverLate ? [lateMessage, lateMessage].map(envelope => ({ type: 'message', seq: 11, envelope })) : [{ type: 'heartbeat', at: Date.now() }]
      return route.fulfill({ contentType: 'text/event-stream', body: events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') })
    }
    if (path === '/api/browser/live' && method === 'GET') return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"type":"tabs","tabs":[]}\n\n' })
    if (path === '/api/browser/navigate' && method === 'POST') { navigation.push(request.postDataJSON().url); return json({}) }
    if (path === '/api/browser/viewport' && method === 'POST') return json({})
    if (method === 'GET') {
      if (path === '/api/config') return json(config)
      if (path === '/api/workspaces') return json({ workspaces: [workspace] })
      if (path === '/api/sessions') return json({ sessions: [session] })
      if (path === '/api/sessions/session-fixture') return json({ summary: session, events: sessionEvents, surface: sessionEvents,
        context: { tokens: 40, limit: 10000, ratio: 0.004 }, metrics: totals, usage: totals, running: false })
      if (path === '/api/sessions/session-fixture/jobs') return json({ jobs: [] })
      if (path === '/api/sessions/session-fixture/questions') return json({ questions: [] })
      // Before the saved General Session arrives, the App briefly consults the draft coding settings.
      if (path === '/api/sessions/session-fixture/coding/commands') return json({ commands: [] })
      if (path === '/api/projects') return json({ projects: [{ ...project, threads: { waiting: 1, failed: 0, working: 0 } }] })
      if (path === '/api/projects/project') {
        const history = longHistory ? Array.from({ length: 60 }, (_, index) => message(`history-${index}`, index % 2 ? 'writer' : 'coordinator', [index % 2 ? 'coordinator' : 'writer'], 'progress', `History message ${index}: one concise update.`, 12000 + index * 1000)) : []
        return json({ ...snapshot, cursor: delivered ? 11 : 10, agentMessages: [...snapshot.agentMessages, ...(delivered ? [lateMessage] : []), ...history] })
      }
      if (path === '/api/projects/project/usage') return json({ total: totals, since: totals, byThread: [] })
      if (path === '/api/usage') return json({ today: totals, week: totals, total: totals, byModel: [], sessions: 0, responses: [] })
      if (path === '/api/changes') return json({ git: true, branch: 'fixture', files: [] })
      if (path === '/api/processes') return json({ processes: [] })
      if (path === '/api/browser') return json({ available: true })
      if (path === '/api/files/tree') {
        const directory = url.searchParams.get('path') ?? ''
        return json({ path: directory, entries: directory === '' ? [{ name: 'docs', path: 'docs', type: 'dir' }] : directory === 'docs' ? [{ name: 'brief.md', path: 'docs/brief.md', type: 'file', size: 28 }] : [] })
      }
      if (path === '/api/files/text' && url.searchParams.get('path') === 'docs/brief.md') return json({ path: 'docs/brief.md', content: '# Short writing brief\n\nUse short headings.\n', size: 45, mtimeMs: at })
      const thread = threads.find(thread => path === `/api/projects/project/threads/${thread.id}`)
      if (thread) return json({ thread, events: [] })
    }
    unexpected.push(`${method} ${path}${url.search}`)
    return route.fulfill({ status: 501, contentType: 'application/json', body: JSON.stringify({ error: `Missing E2E fixture: ${method} ${path}` }) })
  })
  return { unexpected, navigation, streamCursors, releaseLate: () => { deliverLate = true }, expandHistory: () => { longHistory = true } }
}
