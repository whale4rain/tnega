import { describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import {
  DEFAULT_SANDBOX_MODE,
  SANDBOX_MODES,
  SandboxError,
  SandboxService,
  SandboxUnavailableError,
  isAbsolutePath,
  isConfinedMode,
  isSandboxMode,
  resolveSandboxPolicy,
} from '../src/index.js'
import { canonicalPath, writableRoots } from '../src/roots.js'

describe('sandbox vocabulary', () => {
  it('keeps the three Tool Permission modes and defaults to the narrowest one', () => {
    expect(SANDBOX_MODES).toEqual(['read-only', 'workspace-write', 'bypass'])
    expect(DEFAULT_SANDBOX_MODE).toBe('read-only')
    expect(isSandboxMode('read-only')).toBe(true)
    expect(isSandboxMode('danger-full-access')).toBe(false)
    expect(isConfinedMode('bypass')).toBe(false)
    expect(isConfinedMode('workspace-write')).toBe(true)
  })

  it('resolves a fully explicit policy instead of leaving defaults to the provider', () => {
    const absolute = process.platform === 'win32' ? 'C:\\work' : '/work'
    expect(resolveSandboxPolicy({ workspaceRoot: absolute }))
      .toEqual({ mode: 'read-only', workspaceRoot: absolute })
    expect(resolveSandboxPolicy({ mode: 'workspace-write', workspaceRoot: absolute, tempRoot: `${absolute}-tmp` }))
      .toEqual({ mode: 'workspace-write', workspaceRoot: absolute, tempRoot: `${absolute}-tmp` })
  })

  it('refuses a relative workspace root', () => {
    expect(() => resolveSandboxPolicy({ workspaceRoot: 'work' }))
      .toThrowError(expect.objectContaining({ code: 'SANDBOX_INVALID_POLICY' }))
  })

  it('refuses an unknown mode', () => {
    expect(() => resolveSandboxPolicy({
      mode: 'sandbox' as never,
      workspaceRoot: process.platform === 'win32' ? 'C:\\work' : '/work',
    })).toThrowError(expect.objectContaining({ code: 'SANDBOX_INVALID_POLICY' }))
  })

  it('recognises absolute paths on both platforms', () => {
    expect(isAbsolutePath('/work')).toBe(true)
    expect(isAbsolutePath('C:\\work')).toBe(true)
    expect(isAbsolutePath('C:/work')).toBe(true)
    expect(isAbsolutePath('\\\\server\\share')).toBe(true)
    expect(isAbsolutePath('work')).toBe(false)
    expect(isAbsolutePath('./work')).toBe(false)
  })

  it('reports "no backend" as a routable code rather than a generic failure', () => {
    const error = new SandboxUnavailableError('workspace-write', 'bwrap exited 1')
    expect(error).toBeInstanceOf(SandboxError)
    expect(error.name).toBe('SandboxUnavailableError')
    expect(error.code).toBe('SANDBOX_UNAVAILABLE')
    expect(error.message).toContain('workspace-write')
    expect(error.message).toContain('refusing to run the command unconfined')
    expect(error.message).toContain('Runner failure: bwrap exited 1')
  })

  it('exposes the service key through the context declaration', () => {
    const root = new Context()
    const service = new (class extends SandboxService {
      protected override runConfine(): never {
        throw new Error('unused')
      }

      override async status() {
        return { available: false }
      }
    })(root)
    // `ctx.get` 回来的是 core 的可追踪包装，不是同一个对象引用：断言它确实是那个服务。
    expect(root.get('sandbox')).toMatchObject({ name: 'sandbox' })
    expect(service.name).toBe('sandbox')
  })
})

describe('writable roots', () => {
  const absolute = process.platform === 'win32' ? 'C:\\work' : '/work'

  it('grants nothing in read-only and bypass', () => {
    expect(writableRoots({ mode: 'read-only', workspaceRoot: absolute })).toEqual([])
    expect(writableRoots({ mode: 'bypass', workspaceRoot: absolute })).toEqual([])
  })

  it('grants the workspace plus a shared temp area in workspace-write', () => {
    const roots = writableRoots({ mode: 'workspace-write', workspaceRoot: absolute })
    expect(roots).toContain(canonicalPath(absolute))
    expect(roots.length).toBeGreaterThan(1)
    expect(roots).toEqual([...new Set(roots)])
  })

  it('prefers an explicit private temp root over the ambient one', () => {
    const temp = process.platform === 'win32' ? 'C:\\private-tmp' : '/private-tmp'
    expect(writableRoots({ mode: 'workspace-write', workspaceRoot: absolute, tempRoot: temp }))
      .toEqual([canonicalPath(absolute), canonicalPath(temp)])
  })

  it('collapses a temp root that is spelled like the workspace', () => {
    expect(writableRoots({ mode: 'workspace-write', workspaceRoot: absolute, tempRoot: absolute }))
      .toEqual([canonicalPath(absolute)])
  })

  it('returns a stable key for a path that does not exist yet', () => {
    const missing = process.platform === 'win32' ? 'C:\\definitely-missing-tnega' : '/definitely-missing-tnega'
    expect(canonicalPath(missing)).toBe(missing)
  })
})
