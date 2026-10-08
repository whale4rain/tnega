import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { COORDINATOR_SYSTEM_PROMPT, THREAD_SYSTEM_PROMPT } from '../src/index.js'

/**
 * The project prompts teach a protocol that other packages implement: tool
 * names from tool-thread / tool-blackboard / tool-box, and message kinds whose
 * meaning the Project Loop reads into thread state. These checks keep the
 * prompts from naming a tool or a kind that does not exist.
 */
const toolSources = ['tool-thread', 'tool-blackboard', 'tool-box']
  .map(name => readFileSync(new URL(`../../${name}/src/index.ts`, import.meta.url), 'utf8'))
  .concat(readFileSync(new URL('../../../cli/src/project-routines.ts', import.meta.url), 'utf8'))
  .concat(readFileSync(new URL('../../../cli/src/thread-approval.ts', import.meta.url), 'utf8'))
const registered = new Set(toolSources.flatMap(source => [...source.matchAll(/^\s+name: '([a-z_]+)',$/gmu)].map(match => match[1]!)))
const loop = readFileSync(new URL('../../../loop/project-loop/src/index.ts', import.meta.url), 'utf8')

function mentionedTools(prompt: string): string[] {
  return [...new Set([...prompt.matchAll(/\b([a-z]+(?:_[a-z]+)+)\b/gu)].map(match => match[1]!))]
    .filter(name => !['wait_ms', 'expected_version', 'on_report'].includes(name))
}

describe('project prompts', () => {
  it.each([
    ['coordinator', COORDINATOR_SYSTEM_PROMPT],
    ['thread', THREAD_SYSTEM_PROMPT],
  ])('%s prompt only names project tools that are registered', (_name, prompt) => {
    const tools = mentionedTools(prompt)
    expect(tools.length).toBeGreaterThan(3)
    for (const tool of tools) expect(registered, tool).toContain(tool)
  })

  it('teaches threads the message kinds the Project Loop turns into state', () => {
    for (const [kind, state] of [['complete', 'done'], ['request', 'waiting'], ['blocked', 'blocked'], ['failed', 'failed']]) {
      expect(loop).toContain(`${kind}: '${state}'`)
      if (kind !== 'complete') expect(THREAD_SYSTEM_PROMPT).toMatch(new RegExp(`\\b${kind}\\b`, 'u'))
    }
    expect(THREAD_SYSTEM_PROMPT).toContain('marks the thread done')
    // The turn-end report is automatic; the prompt must not also ask for a manual one.
    expect(loop).toMatch(/reportTurnEnd/u)
    expect(THREAD_SYSTEM_PROMPT).toContain('Do not also send it with send_thread_message')
  })

  it('tells the coordinator how to answer a waiting or blocked thread', () => {
    expect(COORDINATOR_SYSTEM_PROMPT).toMatch(/request or blocked message stops that thread/u)
    expect(COORDINATOR_SYSTEM_PROMPT).toContain('kind dispatch')
  })
})
