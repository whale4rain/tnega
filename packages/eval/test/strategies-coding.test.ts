import { describe, expect, it } from 'vitest'

import { checkStrategy, traceStrategy } from '../src/strategies.js'
import type { Evidence, TrialEvidence } from '../src/types.js'

function trial(pass: boolean): TrialEvidence {
  return {
    trial: 1,
    verdicts: [{
      taskId: 't',
      strategy: 'check',
      status: pass ? 'pass' : 'fail',
      score: pass ? 1 : 0,
    }],
    trace: {
      file: 'a',
      startedAt: 0,
      endedAt: 1,
      durationMs: 1,
      metrics: {
        steps: 1,
        turns: 1,
        toolCalls: 1,
        toolErrors: 0,
        invalidToolCalls: 0,
        retries: 0,
        tokens: 0,
        cost: 0,
        recoveredAfterError: false,
      },
    },
    artifacts: {},
  }
}

function evidence(trials: TrialEvidence[]): Evidence {
  return {
    task: { id: 't' },
    messages: [],
    artifacts: {},
    strategyOutputs: {},
    trials,
  }
}

describe('coding strategies', () => {
  it('aggregates per-trial check verdicts into pass rate', async () => {
    const verdict = await checkStrategy().evaluate(
      { ctx: {} as never, run: {} as never },
      { id: 't' },
      evidence([trial(true), trial(false)]),
    )
    expect(verdict.score).toBe(0.5)
    expect(verdict.status).toBe('fail')
  })

  it('scores trace metrics', async () => {
    const bad = trial(true)
    bad.trace.metrics.invalidToolCalls = 1
    bad.trace.metrics.toolErrors = 1
    bad.trace.metrics.toolCalls = 2
    bad.trace.metrics.retries = 1
    bad.trace.metrics.steps = 2
    const verdict = await traceStrategy().evaluate(
      { ctx: {} as never, run: {} as never },
      { id: 't' },
      evidence([bad]),
    )
    expect(verdict.score).toBeGreaterThan(0)
    expect(verdict.score).toBeLessThan(1)
  })

  it('falls back to assert when no trials exist', async () => {
    const verdict = await checkStrategy().evaluate(
      { ctx: {} as never, run: {} as never },
      {
        id: 't',
        inputText: 'ok',
        assertion: { expect: 'ok' },
      },
      {
        task: { id: 't' },
        messages: [],
        artifacts: { output: 'ok' },
        strategyOutputs: {},
        agentResult: {
          input: {},
          output: 'ok',
          finishReason: 'stop',
          steps: [],
          messages: [],
        },
      },
    )
    expect(verdict.status).toBe('pass')
  })
})
