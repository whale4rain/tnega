import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
})
