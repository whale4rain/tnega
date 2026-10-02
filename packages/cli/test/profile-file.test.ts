import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { Context } from '@tnega/core'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  bootAgentRuntimeFromFile,
  createAgentRuntime,
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
  it.each(['plugin', 'ptc'])('cleans up configured plugins when %s startup fails', async stage => {
    const dir = await tempDir()
    const marker = join(dir, 'disposed.txt')
    await writeFile(join(dir, 'first.mjs'), `
      import { writeFileSync } from 'node:fs'
      export function apply(ctx, config) {
        ctx.effect(() => () => writeFileSync(config.marker, 'disposed'))
      }
    `)
    await writeFile(join(dir, 'fail.mjs'), `export default () => { throw new Error('startup failed') }`)
    const file = join(dir, 'startup.json')
    await writeFile(file, JSON.stringify({ bundles: [
      { module: './first.mjs', config: { marker } },
      ...(stage === 'plugin' ? [{ module: './fail.mjs' }] : []),
    ], options: stage === 'ptc' ? { ptc: { timeoutMs: 0 } } : {} }))
    const options = await bootAgentRuntimeFromFile(
      { cwd: dir, sessionFile: join(dir, 'session.jsonl') }, file, { builtinTools: false },
    )
    await expect(createAgentRuntime(options)).rejects.toThrow()
    const { readFile } = await import('node:fs/promises')
    expect(await readFile(marker, 'utf8')).toBe('disposed')
  })

  it('mounts configured local exports and cleans up their effects', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'plugin.mjs'), `
      export const greeting = {
        apply(ctx, config) {
          ctx.on('profile/greeting', value => value.push(config.message))
        }
      }
    `)
    const file = join(dir, 'local.yaml')
    await writeFile(file, `name: local
bundles:
  - module: ./plugin.mjs
    export: greeting
    config:
      message: hello
  - module: ./missing.mjs
    disabled: true
`)
    const profile = await readAgentProfile(file)
    const root = new Context()
    try {
      for (const plugin of profile.bundles) await root.plugin(plugin)
      const messages: string[] = []
      root.emit('profile/greeting', messages)
      expect(messages).toEqual(['hello'])
      await root.fiber.dispose()
      root.emit('profile/greeting', messages)
      expect(messages).toEqual(['hello'])
    } finally { await root.fiber.dispose() }
  })

  it('resolves npm plugins from the profile directory and passes config', async () => {
    const dir = await tempDir()
    const pkg = join(dir, 'node_modules', 'external-plugin')
    await mkdir(pkg, { recursive: true })
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'external-plugin', type: 'module', exports: { import: './index.js' } }))
    await writeFile(join(pkg, 'index.js'), `export default (ctx, config) => { ctx.on('profile/value', values => values.push(config.value)) }`)
    const file = join(dir, 'package.json')
    await writeFile(file, JSON.stringify({ bundles: [{ module: 'external-plugin', config: { value: 42 } }] }))
    const profile = await readAgentProfile(file)
    const root = new Context()
    try {
      for (const plugin of profile.bundles) await root.plugin(plugin)
      const values: number[] = []
      root.emit('profile/value', values)
      expect(values).toEqual([42])
    } finally { await root.fiber.dispose() }
  })

  it.each([
    { module: './invalid.mjs' },
    { module: './invalid.mjs', export: 'missing' },
    { module: 123 },
    { apply: 'not executable' },
    { module: './invalid.mjs', disabled: 'false' },
  ])('rejects invalid plugin references or exports: %j', async entry => {
    const dir = await tempDir()
    await writeFile(join(dir, 'invalid.mjs'), 'export default 42')
    const file = join(dir, 'invalid.json')
    await writeFile(file, JSON.stringify({ bundles: [entry] }))
    await expect(readAgentProfile(file)).rejects.toThrow()
  })

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
