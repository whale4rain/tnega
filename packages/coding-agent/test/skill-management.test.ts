import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { Context } from '@tnega/core'
import { tools, type ToolsService } from '@tnega/tools'
import { skillTools, readSkill } from '../src/skills.js'
import { createSkill, installSkill } from '../src/skill-management.js'
import { createSlashRegistry } from '../src/slash.js'
let home: string
let cwd: string
const document = '---\nname: sample\ndescription: Use when checking samples.\n---\n# Sample\nInstructions.\n'
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tnega-manage-skills-'))
  cwd = join(home, 'workspace')
  await mkdir(cwd)
  vi.stubEnv('TNEGA_HOME', home)
})
afterEach(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }) })
it('creates a discoverable skill and never overwrites existing instructions', async () => {
  await createSkill({ name: 'sample', description: 'Use when checking samples.', content: document })
  expect(await readSkill(cwd, 'sample')).toBe(document)
  await expect(createSkill({ name: 'sample', description: 'Another purpose.' })).rejects.toThrow(/exists/)
  await expect(createSkill({ name: '../escape', description: 'A description.' })).rejects.toThrow(/name/)
  await expect(createSkill({ name: 'different', description: 'A description.', content: document })).rejects.toThrow(/name/)
})
it('imports a local SKILL.md and rejects outside paths and malformed documents', async () => {
  await mkdir(join(cwd, 'source'))
  await writeFile(join(cwd, 'source', 'SKILL.md'), document)
  await installSkill(cwd, { source: 'source' })
  expect(await readSkill(cwd, 'sample')).toBe(document)
  await expect(installSkill(cwd, { source: '..' })).rejects.toThrow()
  await writeFile(join(cwd, 'invalid.md'), '<html>Not a skill</html>')
  await expect(installSkill(cwd, { source: 'invalid.md' })).rejects.toThrow(/frontmatter/)
})
it('imports HTTPS through the guarded http_get tool and preserves call context', async () => {
  const root = new Context()
  await root.plugin(tools)
  await root.plugin(skillTools, { cwd })
  const registry = root.get('tools') as ToolsService
  let childAgent: string | undefined
  let childPtc: unknown
  registry.register({ schema: { name: 'http_get', description: 'Fixture network' }, execute: (_input, options) => {
    childAgent = options.agentId
    childPtc = options.ptcParentCallId
    return { ok: true, body: document, truncated: false }
  } })
  const result = await registry.execute('skill_install', { source: 'https://example.com/SKILL.md' }, { agentId: 'child', ptcParentCallId: 'parent-code-call' })
  expect(result.ok).toBe(true)
  expect(childAgent).toBe('child')
  expect(childPtc).toBe('parent-code-call')
  expect(await readSkill(cwd, 'sample')).toBe(document)
  await root.fiber.dispose()
})
it('routes slash writes through tool execution rather than direct filesystem calls', async () => {
  const executeTool = vi.fn(async () => ({ installed: true }))
  const slash = createSlashRegistry()
  const context = { cwd, tools: [], executeTool }
  await slash.run('/skills', ['create', 'example', 'Use', 'when', 'testing.'], context)
  expect(executeTool).toHaveBeenCalledWith('skill_create', { name: 'example', description: 'Use when testing.' })
  await slash.run('/skills', ['install', 'source'], context)
  expect(executeTool).toHaveBeenCalledWith('skill_install', { source: 'source' })
  expect((await slash.run('/skills', ['create', 'other', 'Description'], { cwd, tools: [] })).kind).toBe('text')
  await expect(readFile(join(home, 'skills', 'example', 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('preserves the only successful concurrent create and rejects symlink targets and escaping sources', async () => {
  const result = await Promise.allSettled([
    createSkill({ name: 'race', description: 'Use when racing.', content: document.replace('name: sample', 'name: race') }),
    createSkill({ name: 'race', description: 'Use when racing.' }),
  ])
  expect(result.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  const outside = join(home, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'SKILL.md'), document)
  await symlink(outside, join(cwd, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(installSkill(cwd, { source: 'escape' })).rejects.toThrow()
  await symlink(outside, join(home, 'skills', 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(createSkill({ name: 'linked', description: 'Use when testing links.' })).rejects.toThrow(/symlink/)
  expect(await readFile(join(outside, 'SKILL.md'), 'utf8')).toBe(document)
})
it('fails closed on guarded, missing, truncated, cancelled or invalid HTTPS downloads', async () => {
  const root = new Context()
  await root.plugin(tools)
  await root.plugin(skillTools, { cwd })
  const registry = root.get('tools') as ToolsService
  const denied = registry.guard(request => request.name === 'http_get' ? 'Network denied' : undefined)
  const source = { source: 'https://example.com/SKILL.md' }
  registry.register({ schema: { name: 'http_get', description: 'Fixture network' }, execute: () => ({ ok: true, body: document, truncated: false }) })
  expect((await registry.execute('skill_install', source)).ok).toBe(false)
  denied()
  registry.unregister('http_get')
  expect((await registry.execute('skill_install', source)).ok).toBe(false)
  registry.register({ schema: { name: 'http_get', description: 'Truncated network' }, execute: () => ({ ok: true, body: document, truncated: true }) })
  expect((await registry.execute('skill_install', source)).ok).toBe(false)
  expect((await registry.execute('skill_install', { source: 'http://example.com/SKILL.md' })).ok).toBe(false)
  const controller = new AbortController()
  controller.abort()
  expect((await registry.execute('skill_install', source, { signal: controller.signal })).ok).toBe(false)
  await expect(readFile(join(home, 'skills', 'sample', 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  await root.fiber.dispose()
})
it('reads skills whose names collide with management subcommands', async () => {
  await createSkill({ name: 'create', description: 'Use when testing the reserved name.' })
  const registry = createSlashRegistry()
  const context = { cwd, tools: [] }
  expect(await registry.suggest('/skills', context)).toContainEqual(expect.objectContaining({ label: 'create', args: ['read', 'create'] }))
  expect(await registry.run('/skills', ['read', 'create'], context)).toMatchObject({ kind: 'text', text: expect.stringContaining('name: create') })
})
