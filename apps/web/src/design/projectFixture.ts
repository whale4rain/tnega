import type { FactRecord, ProjectSnapshot } from '../project/types'

/** Only installed by design.html?project; never imported by the application. */
export function installProjectFixture() {
  const fact = (id: string, kind: string, data: Record<string, unknown>): FactRecord => ({ id, kind, data, seq: 1, version: 1, author: 'Main agent', source: {}, createdAt: 1, updatedAt: 1, deleted: false })
  const snapshot: ProjectSnapshot = {
    project: { id: 'studio', name: 'Product research', goal: 'Build a thoughtful agent workspace, from first idea to a finished experience.', coordinatorId: 'main', createdAt: 1, updatedAt: 1 },
    coordinatorId: 'main', cursor: 0,
    threads: [
      { id: 'main', projectId: 'studio', label: 'Main agent', goal: 'Coordinate the project', depth: 0, state: 'idle', permission: 'workspace-write', createdAt: 1, updatedAt: 1 },
      { id: 'research', projectId: 'studio', label: 'Interaction research', goal: 'Explore a clearer hierarchy for project knowledge.', expect: 'A concise set of design recommendations', detail: 'Reviewing navigation and knowledge patterns.', parentId: 'main', depth: 1, state: 'working', permission: 'read-only', createdAt: 1, updatedAt: 1 },
      { id: 'design', projectId: 'studio', label: 'Visual foundations', goal: 'Define the palette, spacing, and type hierarchy.', parentId: 'main', depth: 1, state: 'done', permission: 'workspace-write', createdAt: 2, updatedAt: 2 },
    ],
    messages: [{ messageId: 'intro', projectId: 'studio', sender: { kind: 'agent', id: 'main' }, recipients: [{ kind: 'user', id: 'user' }], placement: { kind: 'main' }, kind: 'agent-reply', text: '## A shared place for the work\n\nI have split the project into focused threads. Interaction research is underway, and the visual foundations are ready.\n\nYou can explore each thread in **Overview**, browse the results in **Library**, or refine what the team remembers in **Memory**.\n\nTell me what you would like to change next. I will pass the right context to each thread.', refs: [], createdAt: 1 }],
    memory: [fact('principles', 'memory', { text: 'The main agent coordinates work. Focused follow-up messages can also be sent directly to individual threads.' }), fact('voice', 'memory', { text: 'Use quiet surfaces, generous reading space, and precise language. Status should always include a text label.' })],
    library: { artifacts: [fact('visual-spec', 'artifact', { title: 'Visual foundations', mediaType: 'text/markdown', size: 4800 })], resources: [fact('research-notes', 'resource', { title: 'Project interaction research', uri: 'workspace/docs/project-research.md' })] },
  }
  snapshot.messages.unshift({ messageId: 'request', projectId: 'studio', sender: { kind: 'user', id: 'user' }, recipients: [{ kind: 'agent', id: 'main' }], placement: { kind: 'main' }, kind: 'user-message', text: 'Explore the interaction patterns and organize the findings into threads.', refs: [], createdAt: 0 })
  const reply = snapshot.messages.find(message => message.messageId === 'intro')
  if (reply) reply.causationId = 'request'
  const history = new Map(snapshot.memory.map(item => [item.id, [item]]))
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  window.fetch = async (input, init) => {
    const path = new URL(String(input), location.origin).pathname
    if (!path.startsWith('/api/projects/studio')) return json({ error: 'Design preview only' }, 404)
    if (path.endsWith('/stream')) return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(': sample\n\n'))
      init?.signal?.addEventListener('abort', () => controller.close(), { once: true })
    } }), { headers: { 'content-type': 'text/event-stream' } })
    if (path.endsWith('/messages')) return json({ messageId: crypto.randomUUID(), createdAt: Date.now() })
    if (path.includes('/threads/')) return json({ thread: snapshot.threads.find(item => item.id === path.split('/').at(-1)), events: [] })
    if (path.includes('/memory')) {
      const id = path.split('/')[5]
      if (!init?.method) return json({ history: history.get(id ?? '') ?? [] })
      const body: unknown = JSON.parse(String(init.body))
      if (!body || typeof body !== 'object' || !('text' in body) || typeof body.text !== 'string') return json({ error: 'Text required' }, 400)
      const current = snapshot.memory.find(item => item.id === id)
      const record = fact(id ?? crypto.randomUUID(), 'memory', { text: body.text })
      record.version = (current?.version ?? 0) + 1
      record.deleted = 'deleted' in body && body.deleted === true
      snapshot.memory = snapshot.memory.filter(item => item.id !== id)
      if (!record.deleted) snapshot.memory.push(record)
      history.set(record.id, [...(history.get(record.id) ?? []), record])
      return json({ record })
    }
    return json(snapshot)
  }
}
