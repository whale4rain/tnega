import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@tnega/core'
import type { AgentPreStepEvent, SystemPromptService } from '@tnega/agent'
import { workspaceStateDir } from './home-paths.js'

export async function readWorkspacePrompt(workspace: string): Promise<string> {
  try { return await readFile(join(workspaceStateDir(workspace), 'user-prompt.txt'), 'utf8') }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return ''
    throw error
  }
}

export async function writeWorkspacePrompt(workspace: string, prompt: string): Promise<void> {
  if (prompt.length > 32000) throw new RangeError('Workspace prompt must be at most 32000 characters')
  const directory = workspaceStateDir(workspace)
  await mkdir(directory, { recursive: true })
  const temporary = join(directory, `user-prompt-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, prompt.trim(), 'utf8')
    await rename(temporary, join(directory, 'user-prompt.txt'))
  } finally { await rm(temporary, { force: true }) }
}

export const workspacePrompt = {
  name: 'workspace-prompt',
  inject: ['systemPrompt'],
  apply(ctx: Context, { workspace }: { workspace: string }) {
    const prompts: SystemPromptService = ctx.get('systemPrompt')
    const headers = new Map<string, string>()
    const wrap = (prompt: string) => prompt ? `<workspace-user-instructions>\n${prompt}\n</workspace-user-instructions>` : ''
    ctx.effect(() => prompts.registerContext({
      name: 'workspace:user-instructions', order: 100,
      content: async () => wrap(await readWorkspacePrompt(workspace)),
    }))
    // A resumed Agent supplies durable messages with an existing system persona,
    // so initial assembly alone cannot inject dynamic contexts. Keep this prefix
    // in the request header, as toolMemory does, rather than in Session history.
    ctx.on('agent/pre-step', async (event: AgentPreStepEvent, next: () => unknown) => {
      const key = event.agentId ?? ''
      const previous = headers.get(key)
      if (previous && event.messages[0]?.role === 'system' && event.messages[0].content === previous) event.messages.shift()
      const header = wrap(await readWorkspacePrompt(workspace))
      if (header) {
        const first = event.messages[0]
        if (first?.role === 'system' && first.content.endsWith(header)) {
          const base = first.content.slice(0, -header.length).trimEnd()
          if (base) first.content = base
          else event.messages.shift()
        }
        event.messages.unshift({ role: 'system', content: header })
        event.requestHeaderOwnsSystem = true
        headers.set(key, header)
      } else headers.delete(key)
      return next()
    })
    ctx.on('agent/disposed', (event: { id: string }) => { headers.delete(event.id) })
  },
}
