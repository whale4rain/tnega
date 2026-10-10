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
