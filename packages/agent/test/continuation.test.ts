import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { tools } from '@tnega/tools'
import { agents, continuationNudge, BUDGET_NUDGE, CONTINUATION_NUDGE_NAME, looksUnfinished, type AgentRegistry, type LLMAdapter, type LLMCompletion } from '../src/index.js'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

async function run(replies: readonly LLMCompletion[], config: { maxSteps?: number } = {}) {
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
  const handle = await registry.create({ id: 'nudged', file: join(dir, 's.jsonl'), llm, ...config })
  await handle.agent.followup({ text: 'fix the bug' })
  await handle.agent.whenIdle()
  const events = await handle.agent.session.read()
  const turns = events.filter(event => event.type === 'turn/start').length
  const finishes = events.flatMap(event => event.type === 'turn/end' ? [event.payload.finishReason] : [])
  await handle.dispose()
  return { requests, turns, finishes }
}

const step = (content: string, extra: Partial<{ finishReason: string; toolCalls: number }> = {}) => ({
  content,
  finishReason: extra.finishReason ?? 'stop',
  ...(extra.toolCalls !== undefined ? { toolCalls: extra.toolCalls } : {}),
})

describe('continuation nudge', () => {
  it('tells announcements and empty replies from finished answers', () => {
    for (const text of ['Let me run the tests:', 'Now I\'ll update the docs.', 'I found the bug. Let me fix it', '接下来我来修改配置。', '让我先运行测试', '']) {
      expect(looksUnfinished(step(text))).toBe(true)
    }
    for (const text of ['Fixed the parser; tests pass.', 'Let me know if you want the docs updated too.', 'Should I also update the docs?', '已修复，测试通过。']) {
      expect(looksUnfinished(step(text))).toBe(false)
    }
    expect(looksUnfinished(step('half a sente', { finishReason: 'length' }))).toBe(true)
  })

  it('catches a message that trails off on a lead-in instead of a result', () => {
    // A cut-off stream stops on the lead-in and never closes the sentence.
    for (const text of ['Fixed the parser. Now', 'Checking the tests, then', '已完成修复。接下来', 'Now', 'The first half is done, now the tricky part']) {
      expect(looksUnfinished(step(text))).toBe(true)
    }
    // A finished answer may end on the same words, as long as it is a sentence.
    for (const text of ['The parser passes now.', 'Fixed the parser; tests pass now.', '先把这个修好，接下来。', 'Done — the docs are updated now.']) {
      expect(looksUnfinished(step(text))).toBe(false)
    }
    // The same word closing a clause is a claim, not a lead-in; and markdown or
    // an emoji closes a message just as a period does.
    for (const text of ['All tests pass now', 'The build is green now', 'Done, and it works', '**没有线程在等你。**', '全部完成 😊']) {
      expect(looksUnfinished(step(text))).toBe(false)
    }
  })

  it('treats a stop on a tool call or on the step budget as unfinished', () => {
    // The step budget ran out: the last tool results were never read.
    expect(looksUnfinished(step('', { finishReason: 'tool_calls', toolCalls: 1 }), 'max_steps')).toBe(true)
    expect(looksUnfinished(step('Now let me verify the fix.'), 'max_steps')).toBe(true)
    // A concluding tool the harness answered is the model's own ending.
    expect(looksUnfinished(step('', { finishReason: 'tool_calls', toolCalls: 1 }), 'stop')).toBe(false)
    // A user stop or an error is not the nudge's business.
    expect(looksUnfinished(step('Let me run the tests:'), 'cancelled')).toBe(false)
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

  it('gives a run that used up its step budget one last step to report', async () => {
    // One step is allowed; the run spends it on a tool call, so the model never
    // reads the result. The nudge buys exactly one more step for the answer.
    const { requests, finishes } = await run([
      { content: 'Now let me read the file.', toolCalls: [{ id: 'c1', name: 'echo', arguments: { text: 'hi' } }], finishReason: 'tool_calls' },
      { content: 'The file says hi; nothing else was left to do.', finishReason: 'stop' },
    ], { maxSteps: 1 })
    expect(requests).toHaveLength(2)
    expect(requests[1]!.at(-1)).toBe(`${CONTINUATION_NUDGE_NAME}: ${BUDGET_NUDGE}`)
    expect(finishes).toEqual(['stop'])
  })

  it('stops at the step budget when the extra step does not end the work', async () => {
    const { requests, finishes } = await run([
      { content: '', toolCalls: [{ id: 'c1', name: 'echo', arguments: { text: 'hi' } }], finishReason: 'tool_calls' },
    ], { maxSteps: 1 })
    // The nudge gets one step; the model calls tools again and the run ends.
    expect(requests).toHaveLength(2)
    expect(finishes).toEqual(['max_steps'])
  })
})
