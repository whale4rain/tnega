import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readSystemConfig, SystemConfigError, systemConfigProblem, updateSystemConfig } from '../src/config.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function configFile(text?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-config-'))
  dirs.push(dir)
  const file = join(dir, 'config.json')
  if (text !== undefined) await writeFile(file, text, 'utf8')
  return file
}

describe('system config file', () => {
  it('never saves over a file it could not parse', async () => {
    const broken = `{
  "apiKey": "sk-keep-me",
  "workspaces": ["D:/ws"],
}
`
    const file = await configFile(broken)

    expect(await readSystemConfig(file)).toEqual({})
    expect(await systemConfigProblem(file)).toMatch(/JSON/i)
    await expect(updateSystemConfig({ workspaces: ['D:/other'] }, file)).rejects.toBeInstanceOf(SystemConfigError)
    expect(await readFile(file, 'utf8')).toBe(broken)
  })

  it('still creates and updates a valid or missing file', async () => {
    const file = await configFile()
    expect(await systemConfigProblem(file)).toBeUndefined()
    await updateSystemConfig({ model: 'deepseek-flash', vision: true }, file)
    await updateSystemConfig({ workspaces: ['D:/ws'] }, file)
    expect(await readSystemConfig(file)).toEqual({ model: 'deepseek-flash', vision: true, workspaces: ['D:/ws'] })
  })
})
