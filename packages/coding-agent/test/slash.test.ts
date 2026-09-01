import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDefinition } from '@tnega/tools'

import { SlashRegistry, createSlashRegistry } from '../src/slash.js'

describe('SlashRegistry', () => {
  it('normalizes names, lists commands, and runs handlers', async () => {
    const registry = new SlashRegistry()
    registry.register('ping', 'returns pong', () => ({ kind: 'text', text: 'pong' }))

    expect(registry.has('ping')).toBe(true)
    expect(registry.list()).toEqual([
      { name: '/ping', description: 'returns pong' },
    ])
    expect(await registry.run('/ping', [], { cwd: '.', tools: [] })).toEqual({
      kind: 'text',
      text: 'pong',
    })
  })

  it('rejects duplicate registration and returns text for unknown commands', async () => {
    const registry = new SlashRegistry()
    registry.register('x', 'one', () => ({ kind: 'text', text: 'x' }))
    expect(() => registry.register('/x', 'two', () => ({ kind: 'text', text: 'x' })))
      .toThrow(/already registered/)

    const result = await registry.run('/nope', [], { cwd: '.', tools: [] })
    expect(result).toEqual({ kind: 'text', text: 'unknown slash command: /nope' })
  })
})

describe('createSlashRegistry', () => {
  const tools: ToolDefinition[] = [
    { schema: { name: 'skills_list', description: 'list' }, execute: () => [] },
    { schema: { name: 'mcp__files__read', description: 'read' }, execute: () => '' },
    { schema: { name: 'read_file', description: 'builtin' }, execute: () => '' },
  ]

  it('exposes plan, mode, skills, and mcp commands', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tnega-slash-'))
    const skillPath = join(cwd, '.tnega', 'skills', 'typescript')
    await mkdir(skillPath, { recursive: true })
    await writeFile(join(skillPath, 'SKILL.md'), '# TypeScript Style\nBe consistent.\n', 'utf8')
    const registry = createSlashRegistry()
    expect(registry.list().map(command => command.name)).toEqual([
      '/plan',
      '/mode',
      '/skills',
      '/mcp',
    ])

    expect(await registry.run('/plan', [], { cwd: '.', tools })).toMatchObject({
      kind: 'text',
    })
    const mode = await registry.run('/mode', [], { cwd: '.', tools, mode: 'execute' })
    expect(mode).toEqual({
      kind: 'json',
      value: { modes: ['auto', 'plan', 'execute'], current: 'execute' },
    })
    const skills = await registry.run('/skills', [], {
      cwd,
      tools,
      skills: [{ name: 'typescript', path: 'x', description: 'TypeScript Style' }],
    })
    expect(skills).toEqual({
      kind: 'json',
      value: {
        skills: [
          {
            name: 'typescript',
            description: 'TypeScript Style',
          },
        ],
      },
    })
    const skillRead = await registry.run('/skills', ['typescript'], {
      cwd,
      tools,
      skills: [{ name: 'typescript', path: 'x', description: 'TypeScript Style' }],
    })
    expect(skillRead).toEqual({
      kind: 'text',
      text: '# typescript\n\n# TypeScript Style\nBe consistent.\n',
    })
    const mcp = await registry.run('/mcp', [], {
      cwd,
      tools,
      mcp: {
        surveys: [{ name: 'files', status: 'connected', toolCount: 1 }],
        tools: [{ schema: { name: 'mcp__files__read', description: 'read' }, execute: () => '' }],
      },
    })
    expect(mcp).toEqual({
      kind: 'json',
      value: {
        servers: [{ name: 'files', status: 'connected', toolCount: 1 }],
        tools: ['mcp__files__read'],
      },
    })
    await rm(cwd, { recursive: true, force: true })
  })
})
