import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  bootAgentRuntimeFromFile,
  readAgentProfile,
  resolveProfileFile,
  generalAgentProfile,
  profileDir,
} from '../src/index.js'

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-profile-file-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('loadable profile files', () => {
  it('loads a JSON profile with builtin bundle names', async () => {
    const dir = await tempDir()
    const file = join(dir, 'sample.json')
    await writeFile(
      file,
      JSON.stringify({
        name: 'sample',
        bundles: ['general'],
        options: { allowShell: true, builtinTools: false },
      }),
      'utf8',
    )

    const profile = await readAgentProfile(file)
    expect(profile.name).toBe('sample')
    expect(profile.bundles).toEqual([])
    expect(profile.options).toMatchObject({ allowShell: true, builtinTools: false })
  })

  it('loads a YAML profile and preserves bundle ordering', async () => {
    const dir = await tempDir()
    const file = join(dir, 'sample.yaml')
    await writeFile(
      file,
      [
        'name: yaml-profile',
        'bundles:',
        '  - general',
        'options:',
        '  allowNetwork: true',
      ].join('\n'),
      'utf8',
    )

    const profile = await readAgentProfile(file)
    expect(profile.name).toBe('yaml-profile')
    expect(profile.options).toMatchObject({ allowNetwork: true })
  })

  it('throws for an unknown builtin bundle name', async () => {
    const dir = await tempDir()
    const file = join(dir, 'bad.json')
    await writeFile(file, JSON.stringify({ name: 'bad', bundles: ['nope'] }), 'utf8')

    await expect(readAgentProfile(file)).rejects.toThrow('unknown built-in profile bundle')
  })

  it('resolves bare names to the profile dir and file-like relative paths as files', () => {
    const fileLike = 'some/path/p.json'
    expect(resolveProfileFile(fileLike)).toBe(resolve(fileLike))
    expect(resolveProfileFile('my-profile')).toBe(join(profileDir(), 'my-profile.json'))
  })

  it('exposes the shipped general profile', () => {
    expect(generalAgentProfile.name).toBe('general')
  })

  it('boots runtime options from a profile file', async () => {
    const dir = await tempDir()
    const file = join(dir, 'boot.json')
    await writeFile(
      file,
      JSON.stringify({
        name: 'boot',
        bundles: [],
        options: { allowShell: true, builtinTools: false },
      }),
      'utf8',
    )
    const options = await bootAgentRuntimeFromFile(
      { cwd: dir, sessionFile: join(dir, 'session.jsonl') },
      file,
      { allowNetwork: true },
    )
    expect(options.cwd).toBe(dir)
    expect(options.allowShell).toBe(true)
    expect(options.allowNetwork).toBe(true)
    expect(options.plugins).toEqual([])
  })
})
