import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ensureSkillsDir, listSkills, readSkill } from '../src/skills.js'
import { skillTool } from '../src/skill-tool.js'

const dirs: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('skills', () => {
  it('returns an empty list when the skills dir does not exist', async () => {
    const dir = await tempDir('tnega-skills-empty-')
    expect(await listSkills(dir)).toEqual([])
  })

  it('lists skill folders with their first heading as description', async () => {
    const dir = await tempDir('tnega-skills-list-')
    const skills = join(dir, '.tnega', 'skills')
    await mkdir(join(skills, 'alpha'), { recursive: true })
    await mkdir(join(skills, 'beta'), { recursive: true })
    await writeFile(join(skills, 'alpha', 'SKILL.md'), '# Alpha Skill\n\nDo things.\n')
    await writeFile(join(skills, 'beta', 'SKILL.md'), 'no heading here\n')

    const entries = await listSkills(dir)
    expect(entries.map(entry => entry.name)).toEqual(['alpha', 'beta'])
    expect(entries.find(entry => entry.name === 'alpha')?.description).toBe('Alpha Skill')
    expect(entries.find(entry => entry.name === 'beta')?.description).toBe('beta skill')
  })

  it('skips folders without a readable SKILL.md', async () => {
    const dir = await tempDir('tnega-skills-skip-')
    const skills = join(dir, '.tnega', 'skills')
    await mkdir(join(skills, 'no-file'), { recursive: true })
    expect(await listSkills(dir)).toEqual([])
  })

  it('reads a skill and rejects traversal or missing names', async () => {
    const dir = await tempDir('tnega-skills-read-')
    const skills = join(dir, '.tnega', 'skills')
    await mkdir(join(skills, 'alpha'), { recursive: true })
    await writeFile(join(skills, 'alpha', 'SKILL.md'), '# Alpha\n\ncontent\n')

    expect(await readSkill(dir, 'alpha')).toContain('content')
    await expect(readSkill(dir, 'missing')).rejects.toThrow(/skill not found/)
    await expect(readSkill(dir, '../alpha')).rejects.toThrow(/invalid skill name/)
    await expect(readSkill(dir, 'a/b')).rejects.toThrow(/invalid skill name/)
  })

  it('registers one skill tool whose action chooses the verb', async () => {
    const dir = await tempDir('tnega-skills-tools-')
    await ensureSkillsDir(dir)
    const skills = join(dir, '.tnega', 'skills')
    await mkdir(join(skills, 'alpha'), { recursive: true })
    await writeFile(join(skills, 'alpha', 'SKILL.md'), '# Alpha\n\ncontent\n')
    const registry = { execute: async () => ({ ok: false }) } as unknown as Parameters<typeof skillTool>[0]['registry']
    const tool = skillTool({
      cwd: dir,
      registry,
      list: () => listSkills(dir),
      read: name => readSkill(dir, name),
    })

    expect(tool.schema.name).toBe('skill')
    expect(tool.schema.parameters?.properties?.action).toMatchObject({ enum: ['list', 'read', 'create', 'install'] })
    expect(await tool.execute({ action: 'list' }, {})).toMatchObject([
      { name: 'alpha', path: join(skills, 'alpha', 'SKILL.md') },
    ])
    expect(await tool.execute({ action: 'read', name: 'alpha' }, {})).toContain('content')
    await expect(tool.execute({ action: 'read', name: 'nope' }, {})).rejects.toThrow(/skill not found/)
    await expect(tool.execute({ action: 'read' }, {})).rejects.toThrow(/name is required/)
    await expect(tool.execute({ action: 'rename' }, {})).rejects.toThrow(/unknown skill action/)
  })
})
