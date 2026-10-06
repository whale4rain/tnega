import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { systemPrompt } from '@tnega/agent'
import { readWorkspacePrompt, writeWorkspacePrompt, workspacePrompt } from '../src/workspace-prompt.js'

it('persists workspace instructions, refreshes assembly and can clear them', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'tnega-prompt-'))
  const root = new Context()
  try {
    await root.plugin(systemPrompt)
    await root.plugin(workspacePrompt, { workspace })
    expect(await readWorkspacePrompt(workspace)).toBe('')
    await writeWorkspacePrompt(workspace, '  Answer in Chinese.  ')
    expect((await root.get('systemPrompt').assemble()).text).toContain('Answer in Chinese.')
    expect(await readWorkspacePrompt(workspace)).toBe('Answer in Chinese.')
    await writeWorkspacePrompt(workspace, '')
    expect((await root.get('systemPrompt').assemble()).text).not.toContain('Answer in Chinese.')
    await expect(writeWorkspacePrompt(workspace, 'x'.repeat(32001))).rejects.toThrow('32000')
  } finally {
    await root.fiber.dispose()
    await rm(workspace, { recursive: true, force: true })
  }
})
