import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Context } from '@tnega/core'
import { systemPrompt, type SystemPromptService } from '@tnega/agent'
import { tools, type ToolsService } from '@tnega/tools'
import { createCodingAgentPlugin } from '../src/codingAgent.js'
import { session } from '@tnega/session'
import { installBuiltinSkills, listSkills, readSkill, skillTools } from '../src/skills.js'

let home: string
let workspace: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tnega-builtin-skills-'))
  workspace = join(home, 'workspace')
  await mkdir(workspace)
  vi.stubEnv('TNEGA_HOME', home)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})
it('installs offline skills concurrently, preserves edits, and leaves workspace empty', async () => {
  await Promise.all([installBuiltinSkills(), installBuiltinSkills()])
  const entries = await listSkills(workspace)
  expect(entries).toHaveLength(12)
  expect(entries.every(entry => entry.path.startsWith(join(home, 'skills')))).toBe(true)
  const file = join(home, 'skills', 'using-tnega', 'SKILL.md')
  await writeFile(file, '# My custom instructions\n')
  await installBuiltinSkills()
  expect(await readFile(file, 'utf8')).toBe('# My custom instructions\n')
  await expect(readFile(join(workspace, '.tnega', 'skills', 'using-tnega', 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
})
it('discovers global skills and prefers workspace overrides and frontmatter triggers', async () => {
  await installBuiltinSkills()
  const dir = join(workspace, '.tnega', 'skills', 'using-tnega')
  await mkdir(dir, { recursive: true })
  const content = '---\nname: using-tnega\ndescription: Use when working in this project.\n---\n# Local skill\n'
  await writeFile(join(dir, 'SKILL.md'), content)
  const entries = await listSkills(workspace)
  expect(entries).toHaveLength(12)
  expect(entries.find(entry => entry.name === 'using-tnega')?.description).toBe('Use when working in this project.')
  expect(await readSkill(workspace, 'using-tnega')).toBe(content)
  expect(await readSkill(workspace, 'processing-data-files')).toContain('description:')
  await expect(readSkill(workspace, '..\\using-tnega')).rejects.toThrow('invalid skill name')
})
it('exposes an index to child prompts and disposes tools and prompt hooks', async () => {
  const root = new Context()
  await root.plugin(tools)
  const fiber = await root.plugin(skillTools, { cwd: workspace })
  const child = root.extend()
  await child.plugin(systemPrompt)
  const prompt = child.get('systemPrompt') as SystemPromptService
  const registry = root.get('tools') as ToolsService
  expect(registry.list().map(tool => tool.schema.name)).toEqual(['skills_list', 'skill_read', 'skill_create', 'skill_install'])
  const assembly = await prompt.assemble()
  expect(assembly.text).toContain('processing-data-files')
  expect(assembly.text).toContain('skill_read')
  expect(assembly.text).not.toContain('前导零')
  await fiber.dispose()
  expect(registry.list()).toEqual([])
  expect((await prompt.assemble()).text).not.toContain('processing-data-files')
  await root.fiber.dispose()
})

it('reuses shared skill tools for a coding Session without duplicate registration', async () => {
  const root = new Context()
  await root.plugin(session, { file: join(home, 'session.jsonl') })
  await root.plugin(tools)
  await root.plugin(skillTools, { cwd: workspace })
  const coding = await root.plugin(createCodingAgentPlugin({ cwd: workspace, mcp: false, registerAgent: false }))
  const registry = root.get('tools') as ToolsService
  expect(registry.list().map(tool => tool.schema.name)).toEqual(['skills_list', 'skill_read', 'skill_create', 'skill_install'])
  await coding.dispose()
  expect(registry.has('skill_read')).toBe(true)
  await root.fiber.dispose()
})

it('loads offline skills through the source CLI TypeScript loader', () => {
  const root = join(import.meta.dirname, '../../..')
  const code = `
    import { installBuiltinSkills, listSkills } from ${JSON.stringify(pathToFileURL(join(root, 'packages/coding-agent/src/index.ts')).href)};
    await installBuiltinSkills();
    if ((await listSkills(${JSON.stringify(workspace)})).length !== 12) throw new Error('source skill content missing');
    console.log('source skills ok');
  `
  expect(execFileSync(process.execPath, [
    '--disable-warning=ExperimentalWarning', '--experimental-strip-types', '--experimental-transform-types',
    '--experimental-loader', pathToFileURL(join(root, 'scripts/ts-import-loader.mjs')).href, '--input-type=module', '--eval', code,
  ], { cwd: root, encoding: 'utf8', timeout: 20_000 })).toContain('source skills ok')
}, 25_000)
