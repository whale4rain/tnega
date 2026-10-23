import { expect, it } from 'vitest'
import { summarizeSteps } from '../src/tools.js'
import type { ToolView } from '../src/timeline.js'

const tool = (name: string): ToolView => ({ callId: name, name, args: {}, status: 'ok' })

it('sums a run of steps in one plain sentence, in the order the kinds appear', () => {
  expect(summarizeSteps([tool('grep'), tool('glob'), tool('shell')])).toBe('Searched 2 times, ran a command')
  expect(summarizeSteps([tool('read_file')])).toBe('Read a file')
  expect(summarizeSteps([tool('edit_file'), tool('write_file'), tool('shell'), tool('shell')])).toBe('Edited 2 files, ran 2 commands')
  expect(summarizeSteps([tool('run_code')])).toBe('Used a tool')
  expect(summarizeSteps([])).toBe('Thought')
})
