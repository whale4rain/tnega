import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { tools } from '@tnega/tools'
import { agents, continuationNudge, CONTINUATION_NUDGE_NAME, looksUnfinished, type AgentRegistry, type LLMAdapter, type LLMCompletion } from '../src/index.js'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

async function run(replies: readonly LLMCompletion[]) {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-continue-'))
  dirs.push(dir)
  const root = new Context()
  await root.plugin(tools)
  await root.plugin(agents)
  await root.plugin(continuationNudge)
  const requests: string[][] = []
  let index = 0
  const llm: LLMAdapter = {
    async complete(messages) {
      requests.push(messages.map(message => `${message.name ?? message.role}: ${message.content}`))
      return replies[Math.min(index++, replies.length - 1)]!
    },
  }
  const registry = root.get('agents') as AgentRegistry
  const handle = await registry.create({ id: 'nudged', file: join(dir, 's.jsonl'), llm })
  await handle.agent.followup({ text: 'fix the bug' })
  await handle.agent.whenIdle()
  const turns = (await handle.agent.session.read()).filter(event => event.type === 'turn/start').length
  await handle.dispose()
  return { requests, turns }
}

describe('continuation nudge', () => {
  it('tells announcements and empty replies from finished answers', () => {
    for (const text of ['Let me run the tests:', 'Now I\'ll update the docs.', 'I found the bug. Let me fix it', '接下来我来修改配置。', '让我先运行测试', '']) {
      expect(looksUnfinished(text, 'stop')).toBe(true)
    }
    for (const text of ['Fixed the parser; tests pass.', 'Let me know if you want the docs updated too.', 'Should I also update the docs?', '已修复，测试通过。']) {
      expect(looksUnfinished(text, 'stop')).toBe(false)
    }
    expect(looksUnfinished('half a sente', 'length')).toBe(true)
  })

  it('steers an agent that stopped mid-task back to work in the same turn', async () => {
    const { requests, turns } = await run([
      { content: 'I see the problem. Let me fix it now.', finishReason: 'stop' },
      { content: 'Fixed: the parser now handles empty input.', finishReason: 'stop' },
    ])
    expect(requests).toHaveLength(2)
    expect(requests[1]!.at(-1)).toContain(`${CONTINUATION_NUDGE_NAME}: You ended your turn without a tool call`)
    expect(turns).toBe(1)
  })

  it('leaves finished answers alone and gives up after two nudges', async () => {
    expect((await run([{ content: 'Done: the parser handles empty input.', finishReason: 'stop' }])).requests).toHaveLength(1)
    expect((await run([{ content: 'Let me check the tests:', finishReason: 'stop' }])).requests).toHaveLength(3)
  })
})
