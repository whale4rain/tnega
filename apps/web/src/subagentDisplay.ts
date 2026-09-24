import type { DisplayMessage, DisplaySubagent } from './types'

const AGENT_NAME = /^agent:([0-9a-f-]{36})$/i
const START_RESULT = /^Started subagent ([0-9a-f-]{36})\b/i

export function agentIdFromName(name: string | undefined): string | undefined {
  return name?.match(AGENT_NAME)?.[1]
}

export function subagentIdFromResult(output: unknown): string | undefined {
  return typeof output === 'string' ? output.match(START_RESULT)?.[1] : undefined
}

export function subagentFromCall(callId: string, input: unknown): DisplaySubagent {
  const task = input !== null && typeof input === 'object' && 'task' in input
    && typeof input.task === 'string' ? input.task : ''
  const label = input !== null && typeof input === 'object' && 'label' in input
    && typeof input.label === 'string' ? input.label : task.slice(0, 64) || 'Subagent'
  const mode = input !== null && typeof input === 'object' && 'mode' in input
    && input.mode === 'fork' ? 'fork' : 'spawn'
  return { callId, label, task, mode, status: 'starting', replies: [] }
}

export function appendAgentReply(messages: DisplayMessage[], id: string, content: string): void {
  const terminal = /^Subagent [0-9a-f-]{36} (completed|ended)\b/i.test(content)
  const status = terminal ? content.includes(' completed:') ? 'ready' : 'failed' : 'running'
  const displayContent = terminal
    ? content.replace(/^Subagent [0-9a-f-]{36} (?:completed|ended \([^)]*\)): /i, '')
    : content
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const subagent = messages[index]?.subagent
    if (subagent?.id !== id) continue
    subagent.replies.push(displayContent)
    if (terminal) subagent.status = status
    return
  }
  messages.push({
    id: `agent-message-${id}-${messages.length}`,
    role: 'subagent',
    content: '',
    subagent: { id, label: 'Agent message', task: '', mode: 'spawn', status, replies: [displayContent] },
  })
}

export function mergeAgentReplies(messages: DisplayMessage[]): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const fallback = messages[index]?.subagent
    if (!fallback?.id || fallback.callId) continue
    const card = messages.find(message => message.subagent?.callId && message.subagent.id === fallback.id)?.subagent
    if (!card) continue
    card.replies.unshift(...fallback.replies)
    if (fallback.status === 'failed' || fallback.status === 'ready') card.status = fallback.status
    messages.splice(index, 1)
  }
}
