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
    const mcpServer = await registry.run('/mcp', ['files'], {
      cwd,
      tools,
      mcp: {
        surveys: [{ name: 'files', status: 'connected', toolCount: 1 }],
        tools: [{ schema: { name: 'mcp__files__read', description: 'read' }, execute: () => '' }],
      },
    })
    expect(mcpServer).toEqual({
      kind: 'json',
      value: {
        server: { name: 'files', status: 'connected', toolCount: 1 },
        tools: ['mcp__files__read'],
      },
    })
    const mcpTool = await registry.run('/mcp', ['files', 'read'], {
      cwd,
      tools,
      mcp: {
        surveys: [{ name: 'files', status: 'connected', toolCount: 1 }],
        tools: [{ schema: { name: 'mcp__files__read', description: 'read' }, execute: () => '' }],
      },
    })
    expect(mcpTool).toEqual({
      kind: 'json',
      value: {
        server: 'files',
        tool: 'mcp__files__read',
        description: 'read',
        schema: {},
      },
    })
    const mcpMissing = await registry.run('/mcp', ['nope'], {
      cwd,
      tools,
      mcp: {
        surveys: [{ name: 'files', status: 'connected', toolCount: 1 }],
        tools: [{ schema: { name: 'mcp__files__read', description: 'read' }, execute: () => '' }],
      },
    })
    expect(mcpMissing).toEqual({ kind: 'text', text: 'unknown mcp server: nope' })
    await rm(cwd, { recursive: true, force: true })
  })
})

describe('slash suggestions', () => {
  const registry = createSlashRegistry()
  const skills = [{ name: 'typescript', path: 'x', description: 'TypeScript Style' }]
  const mcpTools = [{ schema: { name: 'mcp__files__read', description: 'read' }, execute: () => '' }]
  const mcp = {
    surveys: [{ name: 'files', status: 'connected' as const, toolCount: 1 }],
    tools: mcpTools,
  }

  it('suggests workspace skills', async () => {
    const suggestions = await registry.suggest('/skills', {
      cwd: '.',
      tools: [],
      skills,
    })
    expect(suggestions).toEqual([
      {
        command: '/skills',
        args: ['typescript'],
        label: 'typescript',
        detail: 'TypeScript Style',
      },
    ])
  })

  it('suggests mcp servers and tools', async () => {
    const suggestions = await registry.suggest('/mcp', {
      cwd: '.',
      tools: mcpTools,
      mcp,
    })
    expect(suggestions).toEqual([
      { command: '/mcp', args: ['files'], label: 'files', detail: 'connected / 1 tools' },
      {
        command: '/mcp',
        args: ['files', 'read'],
        label: 'mcp__files__read',
        detail: 'read',
      },
    ])
  })

  it('returns no suggestions for commands without a picker', async () => {
    expect(await registry.suggest('/mode', { cwd: '.', tools: [] })).toEqual([])
    expect(await registry.suggest('/nope', { cwd: '.', tools: [] })).toEqual([])
  })
})
