import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build.mjs'], {
    cwd: root,
    stdio: 'pipe',
  })
}, 30_000)

describe('publish metadata', () => {
  it('exposes tnega as a public CLI package', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
    expect(pkg.name).toBe('tnega')
    expect(pkg.private).toBe(false)
    expect(pkg.license).toBe('MIT')
    expect(pkg.bin?.tnega).toBe('./dist/bin.js')
    expect(pkg.files).toContain('dist')
    expect(pkg.engines.node).toBe('>=22')
  })

  it('keeps the bin entry in source so a fresh build can emit it', () => {
    const bin = readFileSync(resolve(root, 'packages/cli/src/bin.ts'), 'utf8')
    expect(bin.startsWith('#!/usr/bin/env node')).toBe(true)
    expect(bin).toContain("main(process.argv.slice(2))")
  })
})

describe('packed artifact', () => {
  it('builds a runnable self-contained bin', () => {
    const bin = resolve(root, 'dist/bin.js')
    expect(existsSync(bin)).toBe(true)
    let output = ''
    try {
      execFileSync(process.execPath, [bin, 'no-such-command'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      const err = error as { stdout?: unknown }
      output = String(err.stdout ?? '')
    }
    expect(output).toContain('unknown command: no-such-command')
  })

  it('bundles the library entry without leaking internal workspace paths', () => {
    const index = readFileSync(resolve(root, 'dist/index.js'), 'utf8')
    expect(index).not.toMatch(/from ["']@tnega\//)
    expect(index).toContain('runAgentCommand')
  })

  it('resolves the library entry as a consumer via package exports', async () => {
    const mod = await import('tnega')
    expect(typeof mod.Context).toBe('function')
    expect(typeof mod.SessionLog).toBe('function')
    expect(typeof mod.ToolsService).toBe('function')
    expect(typeof mod.AgentService).toBe('function')
    expect(typeof mod.openaiCompatAdapter).toBe('function')
    expect(typeof mod.anthropicMessagesAdapter).toBe('function')
    expect(typeof mod.createLlmAdapter).toBe('function')
    expect(typeof mod.lookupModel).toBe('function')
    expect(mod.DEFAULT_MODEL).toBe('deepseek-v4-flash')
    expect(typeof mod.main).toBe('function')
    expect(mod.coreApi).toBeTruthy()
  })

  it('resolves every documented subpath as a consumer via package exports', async () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
    const subpaths = [
      'agent',
      'cli/runtime',
      'core',
      'eval',
      'events',
      'evolve',
      'llm',
      'services',
      'session',
      'tools',
    ]
    for (const subpath of subpaths) {
      expect(pkg.exports[`./${subpath}`]).toBeTruthy()
      const mod = await import(`tnega/${subpath}`)
      expect(Object.keys(mod).length).toBeGreaterThan(0)
    }
  })

  it('emits a runtime js file for every subpath entry', () => {
    const names = [
      'agent',
      'cli-runtime',
      'core',
      'eval',
      'events',
      'evolve',
      'llm',
      'services',
      'session',
      'tools',
    ]
    for (const name of names) {
      expect(existsSync(resolve(root, `dist/${name}.js`))).toBe(true)
    }
  })

  it('publishes self-contained declarations without @tnega/* imports', () => {
    const rootDir = resolve(root, 'dist/types')
    const files = collectDeclarations(rootDir)
    expect(files.length).toBeGreaterThan(10)
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      expect(text).not.toMatch(/['"]@tnega\//)
    }
    expect(existsSync(resolve(rootDir, 'src/index.d.ts'))).toBe(true)
  })
})

function collectDeclarations(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectDeclarations(path))
    } else if (entry.name.endsWith('.d.ts')) {
      files.push(path)
    }
  }
  return files
}
