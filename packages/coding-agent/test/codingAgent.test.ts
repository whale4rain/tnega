import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { Context } from '@tnega/core'
import { session } from '@tnega/session'
import { tools, type ToolsService } from '@tnega/tools'

import {
  createCodingAgentPlugin,
  type CodingService,
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

async function mountRoot(cwd: string): Promise<Context> {
  const root = new Context()
  await root.plugin(session, { file: join(cwd, 'session.jsonl') })
  await root.plugin(tools)
  return root
}

describe('createCodingAgentPlugin', () => {
  it('registers coding tools and exposes the coding service', async () => {
    const cwd = await tempDir('tnega-coding-mount-')
    const root = await mountRoot(cwd)
    const fiber = root.plugin(createCodingAgentPlugin({
      cwd,
      mode: 'plan',
      mcp: false,
    }))
    await fiber

    const service = root.get('tools') as ToolsService
    expect(service.has('plan_execute_mark')).toBe(true)
    expect(service.has('plan_execute_result')).toBe(true)
    expect(service.has('skills_list')).toBe(true)
    expect(service.has('skill_read')).toBe(true)

    const coding = root.get('coding') as CodingService
    expect(coding.survey()).toEqual({
      agentType: 'coding',
      mode: 'plan',
      planTools: 2,
      skillsEnabled: true,
      skills: 2,
      mcpEnabled: false,
      mcpServers: 0,
      mcpTools: 0,
    })
    expect(coding.commands().map(command => command.name)).toContain('/plan')

    const mode = await coding.runCommand('/mode', [])
    expect(mode).toEqual({
      kind: 'json',
      value: { modes: ['auto', 'plan', 'execute'], current: 'plan' },
    })

    await fiber.dispose()
    expect(service.has('plan_execute_mark')).toBe(false)
    expect(service.has('skills_list')).toBe(false)
    expect(root.get('coding')).toBeUndefined()
  })

  it('lists and reads workspace skills through slash commands', async () => {
    const cwd = await tempDir('tnega-coding-skills-')
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(cwd, '.tnega', 'skills', 'typescript'), { recursive: true })
    await writeFile(
      join(cwd, '.tnega', 'skills', 'typescript', 'SKILL.md'),
      '# TypeScript Style\nFollow the repository conventions.\n',
      'utf8',
    )
    const root = await mountRoot(cwd)
    const fiber = root.plugin(createCodingAgentPlugin({
      cwd,
      mcp: false,
    }))
    await fiber

    const coding = root.get('coding') as CodingService
    const listed = await coding.runCommand('/skills', [])
    expect(listed).toMatchObject({
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

    const read = await coding.runCommand('/skills', ['typescript'])
    expect(read).toEqual({
      kind: 'text',
      text: '# typescript\n\n# TypeScript Style\nFollow the repository conventions.\n',
    })

    const missing = await coding.runCommand('/skills', ['unknown'])
    expect(missing).toEqual({ kind: 'text', text: 'unknown skill: unknown' })

    await fiber.dispose()
  })

  it('reports mcp servers and tools through slash commands', async () => {
    const cwd = await tempDir('tnega-coding-mcp-slash-')
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(cwd, '.tnega'), { recursive: true })
    await writeFile(join(cwd, '.tnega', 'mcp.json'), JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url))],
        },
      },
    }))

    const root = await mountRoot(cwd)
    const fiber = root.plugin(createCodingAgentPlugin({
      cwd,
      skills: false,
    }))
    await fiber

    const coding = root.get('coding') as CodingService
    const result = await coding.runCommand('/mcp', [])
    expect(result).toMatchObject({
      kind: 'json',
      value: {
        servers: [
          {
            name: 'fixture',
            status: 'connected',
            toolCount: 1,
          },
        ],
        tools: ['mcp__fixture__echo'],
      },
    })

    await fiber.dispose()
  })

  it('switches the session mode through the setMode callback', async () => {
    const cwd = await tempDir('tnega-coding-mode-')
    const root = await mountRoot(cwd)
    const switched: string[] = []
    const fiber = root.plugin(createCodingAgentPlugin({
      cwd,
      mode: 'plan',
      mcp: false,
      setMode: (next) => {
        switched.push(next)
      },
    }))
    await fiber

    const coding = root.get('coding') as CodingService
    const result = await coding.runCommand('/mode', ['execute'])
    expect(switched).toEqual(['execute'])
    expect(result).toEqual({
      kind: 'json',
      value: {
        modes: ['auto', 'plan', 'execute'],
        current: 'execute',
        switched: true,
      },
    })

    const invalid = await coding.runCommand('/mode', ['sandbox'])
    expect(invalid).toEqual({
      kind: 'text',
      text: 'invalid mode: sandbox; expected auto, plan or execute',
    })
    expect(switched).toEqual(['execute'])

    await fiber.dispose()
  })

  it('registers MCP tools and closes servers on dispose', async () => {
    const cwd = await tempDir('tnega-coding-mcp-')
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(cwd, '.tnega'), { recursive: true })
    await writeFile(join(cwd, '.tnega', 'mcp.json'), JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url))],
        },
      },
    }))

    const root = await mountRoot(cwd)
    const fiber = root.plugin(createCodingAgentPlugin({
      cwd,
      mode: 'auto',
      skills: false,
      mcp: true,
    }))
    await fiber

    const service = root.get('tools') as ToolsService
    expect(service.has('mcp__fixture__echo')).toBe(true)
    const coding = root.get('coding') as CodingService
    expect(coding.survey().mcpTools).toBe(1)
    expect(coding.survey().mcpServers).toBe(1)

    await fiber.dispose()
    expect(service.has('mcp__fixture__echo')).toBe(false)
  })

  it('can register the agent service only when requested', async () => {
    const cwd = await tempDir('tnega-coding-register-agent-')
    const root = await mountRoot(cwd)
    const fiber = root.plugin(createCodingAgentPlugin({
      cwd,
      mode: 'auto',
      skills: false,
      mcp: false,
      registerAgent: false,
    }))
    await fiber

    expect(root.get('coding')).toBeTruthy()
    expect(root.get('agent')).toBeUndefined()

    await fiber.dispose()
  })
})
