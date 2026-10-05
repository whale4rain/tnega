import { describe, expect, it } from 'vitest'
import type { LLMAdapter } from '@tnega/agent'
import type { ModelMessage } from '@tnega/session'
import { autoContextBudget, splitSummary, SUMMARY_PREFIX } from '../src/auto-compaction.js'

function recorder(reply: string): { llm: LLMAdapter; requests: Array<readonly ModelMessage[]> } {
  const requests: Array<readonly ModelMessage[]> = []
  return {
    requests,
    llm: {
      async complete(messages) {
        requests.push(messages)
        return { content: reply, finishReason: 'stop' }
      },
    },
  }
}

const conversation: ModelMessage[] = [
  { role: 'system', content: 'You are Tnega.' },
  { role: 'system', content: `${SUMMARY_PREFIX}## Goal\nFix the parser` },
  { role: 'user', content: 'Now also update the docs' },
  { role: 'assistant', content: 'Reading the docs.', tool_calls: [{ id: 'c1', name: 'read_file', arguments: { path: 'README.md' } }] },
  { role: 'tool', content: '# Parser\n…', tool_call_id: 'c1' },
]

describe('automatic compaction', () => {
  it('summarizes the conversation without the system prompt, updating the earlier summary', async () => {
    const { llm, requests } = recorder('## Goal\nFix the parser and its docs')
    const budget = autoContextBudget({ llm: () => llm, contextWindow: 64_000 })
    expect(budget.limit).toBe(64_000)
    const summary = await budget.summarize!(conversation, { tokens: 50_000, limit: 64_000, ratio: 0.78 })
    expect(summary).toEqual([{ role: 'system', content: `${SUMMARY_PREFIX}## Goal\nFix the parser and its docs` }])
    const prompt = String(requests[0]![1]!.content)
    expect(prompt).toContain('<previous-summary>\n## Goal\nFix the parser\n</previous-summary>')
    expect(prompt).toContain('[User]: Now also update the docs')
    expect(prompt).not.toContain('You are Tnega.')
  })

  it('asks the model whether the run is about to finish and reads a plain YES or NO', async () => {
    for (const [reply, expected] of [['YES', true], ['Yes — only the summary is left.', true], ['NO', false], ['Not yet.', false]] as const) {
      const { llm, requests } = recorder(reply)
      expect(await autoContextBudget({ llm: () => llm }).nearEnd!(conversation, { tokens: 1, limit: 2, ratio: 0.8 })).toBe(expected)
      expect(String(requests[0]![1]!.content)).toContain('[Assistant tool calls]: read_file(path="README.md")')
    }
  })

  it('separates the previous summary from the conversation', () => {
    expect(splitSummary(conversation)).toEqual({ conversation: conversation.slice(2), previousSummary: '## Goal\nFix the parser' })
    expect(splitSummary(conversation.slice(2)).previousSummary).toBeUndefined()
  })
})
