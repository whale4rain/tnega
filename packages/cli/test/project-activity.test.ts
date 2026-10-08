import { expect, it } from 'vitest'
import { describeToolCall } from '../src/project-activity.js'

it('turns a tool call into a few words for the thread status line', () => {
  expect(describeToolCall('write_file', { path: '/repo/src/lib/count.mjs' })).toBe('Editing lib/count.mjs')
  expect(describeToolCall('read_file', { path: 'README.md' })).toBe('Reading README.md')
  expect(describeToolCall('shell', { command: 'node --test count.test.mjs' })).toBe('Running node --test count.test.mjs')
  expect(describeToolCall('http_get', { url: 'https://example.com/a' })).toBe('Fetching example.com')
  expect(describeToolCall('grep', { pattern: 'x' })).toBe('Searching the workspace')
  expect(describeToolCall('update_checklist', null)).toBe('Update checklist')
  expect(describeToolCall('shell', { command: 'x'.repeat(80) }).length).toBeLessThan(50)
})
