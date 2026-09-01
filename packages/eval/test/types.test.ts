import { describe, expect, it } from 'vitest'

import type { EvalRunOptions, Evidence, Task } from '../src/index.js'

describe('eval types', () => {
  it('accepts coding task fields', () => {
    const task: Task = {
      id: 'py-fib',
      inputText: 'implement fib',
      fixture: { root: 'fixtures/py-math' },
      check: 'python -m unittest discover -s . -p "test_*.py"',
      trials: 3,
      split: 'val',
      permissions: {
        shell: { enabled: true, allow: ['python'], deny: ['rm'] },
        network: false,
      },
    }
    expect(task.trials).toBe(3)
  })

  it('accepts coding run options', () => {
    const options: EvalRunOptions = {
      candidate: { name: 'deepseek', plugin: () => {} },
      tasks: [],
      coding: {
        llm: {
          async complete() {
            return { finishReason: 'stop' }
          },
        },
        agent: { systemPrompt: 'custom' },
        coding: { skills: false, planTools: true, mcp: false },
      },
    }
    expect(options.coding?.agent?.systemPrompt).toBe('custom')
  })

  it('builds evidence with trials', () => {
    const evidence: Evidence = {
      task: { id: 't' },
      messages: [],
      artifacts: {},
      strategyOutputs: {},
      trials: [],
    }
    expect(evidence.trials).toEqual([])
  })
})
