import { expect, it } from 'vitest'
import { createBuiltinToolDefinitions } from '../src/builtins.js'

it('declares how each builtin tool behaves after a restart cut it off', () => {
  const definitions = createBuiltinToolDefinitions({ allowShell: true, allowNetwork: true })
  const byName = Object.fromEntries(definitions.map(definition => [definition.schema.name, definition.interruption]))
  expect(byName).toMatchObject({
    read_file: 'retry',
    list_dir: 'retry',
    http_get: 'retry',
    write_file: 'confirm',
    shell: 'confirm',
  })
  expect(definitions.every(definition => definition.interruption !== undefined)).toBe(true)
})

it('reports shell output as it arrives', async () => {
  const shell = createBuiltinToolDefinitions({ allowShell: true }).find(definition => definition.schema.name === 'shell')!
  const seen: string[] = []
  await shell.execute({ command: 'echo first && echo second' }, { progress: output => seen.push(output) })
  expect(seen.join('')).toMatch(/first\s+second/)
})
