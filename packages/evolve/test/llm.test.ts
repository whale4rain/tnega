import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { LLMAdapter } from '@tnega/agent'
import { Context } from '@tnega/core'
import {
  evalPlugin,
  type EvalService,
  type Task,
} from '@tnega/eval'
import { session, type ModelMessage } from '@tnega/session'
import { tools } from '@tnega/tools'

import {
  LlmProposalError,
  createLlmProposeRule,
  emptyDiagnosis,
  llmCandidate,
  parseLlmProposal,
  withSystemPrompt,
  type Candidate,
} from '../src/index.js'

const dirs: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function fakeAdapter(
  content: string,
  onComplete?: (messages: readonly ModelMessage[]) => void,
): LLMAdapter {
  return {
    async complete(messages) {
      onComplete?.(messages)
      return { content, finishReason: 'stop' }
    },
  }
}

describe('parseLlmProposal', () => {
  it('parses a plain JSON proposal', () => {
    expect(parseLlmProposal(JSON.stringify({
      name: 'fix-1',
      system: 'answer target',
      rationale: 'baseline failed',
      mutationDescription: 'replace system prompt',
    }))).toEqual({
      name: 'fix-1',
      system: 'answer target',
      rationale: 'baseline failed',
      mutationDescription: 'replace system prompt',
    })
  })

  it('parses a Markdown fenced JSON proposal and trims fields', () => {
    const proposal = parseLlmProposal('```json\n{\n  "name": " fix-2 ",\n'
      + '  "system": "be concise",\n'
      + '  "rationale": "more stable",\n'
      + '  "mutationDescription": "tighten prompt"\n'
      + '}\n```')
    expect(proposal.name).toBe('fix-2')
    expect(proposal.system).toBe('be concise')
  })

  it('rejects invalid, non-object and incomplete proposals', () => {
    expect(() => parseLlmProposal('not json')).toThrow(LlmProposalError)
    expect(() => parseLlmProposal('[1, 2, 3]')).toThrow(LlmProposalError)
    expect(() => parseLlmProposal('{"name":"x"}')).toThrow(/system/)
    expect(() => parseLlmProposal('{"name":"x","system":"s"}')).toThrow(/rationale/)
  })
})

describe('withSystemPrompt', () => {
  it('injects a system message exactly once and never duplicates an existing one', async () => {
    const seen: ModelMessage[][] = []
    const wrapped = withSystemPrompt(fakeAdapter('ok', messages => seen.push([...messages])), 'be strict')

    await wrapped.complete([{ role: 'user', content: 'hi' }], [], {})
    expect(seen[0]!.map(message => message.role)).toEqual(['system', 'user'])
    expect(seen[0]![0]!.content).toBe('be strict')

    await wrapped.complete([
      { role: 'system', content: 'mine' },
      { role: 'user', content: 'hi' },
    ], [], {})
    expect(seen[1]!.map(message => message.role)).toEqual(['system', 'user'])
    expect(seen[1]![0]!.content).toBe('mine')
  })
})

describe('createLlmProposeRule', () => {
  it('proposes a candidate from an LLM completion', async () => {
    const rule = createLlmProposeRule({
      adapter: fakeAdapter(JSON.stringify({
        name: 'fix-output',
        system: 'answer target',
        rationale: 'baseline failed the assert task',
        mutationDescription: 'switch system prompt to answer target',
      })),
      maxTurns: 1,
      maxSteps: 2,
    })

    const produced = await rule.apply({
      diagnosis: emptyDiagnosis(),
      iteration: 0,
      history: [],
      rules: [rule],
    })
    expect(produced).toBeTruthy()
    const candidate = Array.isArray(produced) ? produced[0]! : produced as Candidate
    expect(candidate.name).toBe('fix-output')
    expect(candidate.config).toMatchObject({ system: 'answer target' })
    expect(candidate.mutation).toMatchObject({
      type: 'system-prompt',
      description: 'switch system prompt to answer target',
      patch: { system: 'answer target' },
    })
    expect(candidate.rationale).toBe('baseline failed the assert task')
  })
})

describe('llmCandidate', () => {
  it('runs inside eval as a real agent loop with an injected system prompt', async () => {
    const dir = await tempDir('tnega-llm-candidate-')
    const seen: ModelMessage[][] = []
    const candidate = llmCandidate({
      name: 'llm-agent',
      system: 'answer with hi',
      adapter: fakeAdapter('hi', messages => seen.push([...messages])),
      maxTurns: 1,
      maxSteps: 2,
    })
    const root = new Context()
    await root.plugin(session, { file: join(dir, 'root-session.jsonl') })
    await root.plugin(tools)
    await root.plugin(evalPlugin, { outputDir: join(dir, 'runs') })
    const evalService = (root as unknown as { eval: EvalService }).eval

    const tasks: Task[] = [{
      id: 't1',
      inputText: 'hello',
      assertion: { expect: 'hi' },
    }]
    const run = await evalService.run({
      candidate,
      tasks,
      strategyNames: ['assert'],
    })

    expect(run.summary.passed).toBe(1)
    expect(run.summary.failed).toBe(0)
    expect(run.verdicts[0]!.status).toBe('pass')
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[0]![0]).toMatchObject({ role: 'system', content: 'answer with hi' })
  })
})
