import { chmodSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import type { ExecutionProvider, ProcessResult } from '@tnega/execution'
import { SearchError } from '@tnega/search'
import {
  assertSearchSucceeded,
  parseGlobPaths,
  parseGrepMatches,
} from '../src/parse.js'
import { buildGlobArgv, buildGrepArgv } from '../src/argv.js'
import { resolveRipgrepPath } from '../src/binary.js'
import { RipgrepSearch } from '../src/index.js'

const dirs: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const honoring: Parameters<typeof buildGlobArgv>[1] = {
  respectGitignore: true,
  excludes: ['node_modules'],
}

describe('ripgrep argument construction', () => {
  it('builds a glob command that honors .gitignore', () => {
    expect(buildGlobArgv('**/*.ts', honoring)).toEqual([
      '--files',
      '--glob=**/*.ts',
      '--sort=modified',
      '--no-config',
      '--hidden',
      '--no-require-git',
      '--glob=!**/node_modules',
    ])
  })

  it('searches ignored files when gitignore honoring is off', () => {
    const argv = buildGlobArgv('**/*.ts', { respectGitignore: false, excludes: [] })
    expect(argv).toContain('--no-ignore')
    expect(argv).not.toContain('--no-require-git')
  })

  it('keeps the search root behind a terminator so a leading dash is a path', () => {
    expect(buildGlobArgv('**/*.ts', { ...honoring, path: 'docs' }).slice(-2))
      .toEqual(['--', 'docs'])
    expect(buildGlobArgv('**/*.ts', { ...honoring, path: '.' })).not.toContain('--')
  })

  it('builds a grep command that carries the pattern and file filter', () => {
    expect(buildGrepArgv('value', { ...honoring, glob: '**/*.md' })).toEqual([
      '--json',
      '--regexp=value',
      '--glob=**/*.md',
      '--no-config',
      '--hidden',
      '--no-require-git',
      '--glob=!**/node_modules',
    ])
  })

  // ripgrep's --glob is gitignore-flavoured: a pattern without a slash matches a
  // basename at any depth, so a bare `*` would mean "every file in the tree".
  // The tools document path-glob semantics, so slash-less patterns get anchored.
  it('anchors a slash-less pattern to the search root', () => {
    expect(buildGlobArgv('*', honoring)).toContain('--glob=/*')
    expect(buildGlobArgv('*.ts', honoring)).toContain('--glob=/*.ts')
    expect(buildGlobArgv('?op.ts', honoring)).toContain('--glob=/?op.ts')
    expect(buildGlobArgv('{a,b}.md', honoring)).toContain('--glob=/{a,b}.md')
  })

  it('leaves a pattern that already crosses segments alone', () => {
    expect(buildGlobArgv('**/*.ts', honoring)).toContain('--glob=**/*.ts')
    expect(buildGlobArgv('packages/*/README.md', honoring))
      .toContain('--glob=packages/*/README.md')
    // `**` alone still means "everything below the root".
    expect(buildGlobArgv('**', honoring)).toContain('--glob=/**')
  })

  it('anchors the grep file filter the same way', () => {
    expect(buildGrepArgv('value', { ...honoring, glob: '*.md' }))
      .toContain('--glob=/*.md')
    expect(buildGrepArgv('value', { ...honoring, glob: '**/*.md' }))
      .toContain('--glob=**/*.md')
  })

  it('does not descend when the pattern can only match the search root', () => {
    for (const pattern of ['*', '*.ts', '?op.ts', '{a,b}.md']) {
      const argv = buildGlobArgv(pattern, honoring)
      expect(argv).toContain('--max-depth')
      expect(argv[argv.indexOf('--max-depth') + 1]).toBe('1')
    }
    // `**` crosses segments, so it must keep descending.
    expect(buildGlobArgv('**', honoring)).not.toContain('--max-depth')
    expect(buildGlobArgv('**/*.ts', honoring)).not.toContain('--max-depth')
  })

  it('bounds a root-only grep filter the same way', () => {
    expect(buildGrepArgv('value', { ...honoring, glob: '*.md' })).toContain('--max-depth')
    expect(buildGrepArgv('value', { ...honoring, glob: '**/*.md' })).not.toContain('--max-depth')
    // No filter at all means a full recursive search.
    expect(buildGrepArgv('value', honoring)).not.toContain('--max-depth')
  })
})

describe('ripgrep binary resolution', () => {
  it('resolves an explicitly configured binary', async () => {
    const dir = await tempDir('tnega-ripgrep-explicit-')
    const binary = join(dir, process.platform === 'win32' ? 'rg.exe' : 'rg')
    await writeFile(binary, '#!/bin/sh\n', 'utf8')
    if (process.platform !== 'win32') chmodSync(binary, 0o755)
    await expect(resolveRipgrepPath(binary)).resolves.toBe(binary)
  })

  it('fails with SEARCH_FAILED for a configured path that is not executable', async () => {
    const dir = await tempDir('tnega-ripgrep-missing-')
    await expect(resolveRipgrepPath(join(dir, 'absent-rg')))
      .rejects.toMatchObject({ name: 'SearchError', code: 'SEARCH_FAILED' })
  })
})

describe('ripgrep output parsing', () => {
  it('normalizes separators and drops blank lines', () => {
    expect(parseGlobPaths('findFiles', 'src\\a.ts\n\nsrc/b.ts\n'))
      .toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('keeps only match records and strips the trailing newline', () => {
    const stdout = [
      JSON.stringify({ type: 'begin', data: {} }),
      JSON.stringify({
        type: 'match',
        data: { path: { text: 'a\\b.ts' }, lines: { text: 'hit\r\n' }, line_number: 7 },
      }),
      JSON.stringify({ type: 'end', data: {} }),
      JSON.stringify({ type: 'summary', data: {} }),
    ].join('\n')

    expect(parseGrepMatches('searchText', stdout))
      .toEqual([{ file: 'a/b.ts', line: 7, text: 'hit' }])
  })

  it('marks a match whose line is not UTF-8 instead of failing the search', () => {
    const stdout = JSON.stringify({
      type: 'match',
      data: { path: { text: 'a.ts' }, lines: { bytes: 'AA==' }, line_number: 1 },
    })
    expect(parseGrepMatches('searchText', stdout))
      .toEqual([{ file: 'a.ts', line: 1, text: '(line is not valid UTF-8)' }])
  })

  it('treats malformed records as a search failure, not a partial result', () => {
    expect(() => parseGrepMatches('searchText', 'not json'))
      .toThrow(SearchError)
    expect(() => parseGrepMatches('searchText', JSON.stringify({ type: 'match', data: {} })))
      .toThrow(/no path/)
    expect(() => parseGrepMatches('searchText', JSON.stringify({
      type: 'match',
      data: { path: { text: 'a.ts' }, lines: { text: 'x\n' } },
    }))).toThrow(/no line number/)
  })
})

describe('search exit classification', () => {
  const base = { stdout: '', stderr: '', stdoutTruncated: false }

  it('accepts exits 0 and 1', () => {
    expect(() => assertSearchSucceeded('findFiles', { ...base, exitCode: 0 }, 1000)).not.toThrow()
    expect(() => assertSearchSucceeded('findFiles', { ...base, exitCode: 1 }, 1000)).not.toThrow()
  })

  it('classifies a rejected pattern as SEARCH_INVALID_PATTERN', () => {
    expect(() => assertSearchSucceeded(
      'searchText',
      { ...base, exitCode: 2, stderr: 'regex parse error:\n    (?:[unclosed)' },
      1000,
    )).toThrow(/SEARCH_INVALID_PATTERN|pattern rejected/)
  })

  it('reports any other failed run as SEARCH_FAILED with diagnostics', () => {
    try {
      assertSearchSucceeded(
        'findFiles',
        { ...base, exitCode: 2, stderr: 'permission denied' },
        1000,
      )
      throw new Error('expected a throw')
    } catch (error) {
      expect(error).toBeInstanceOf(SearchError)
      expect((error as SearchError).code).toBe('SEARCH_FAILED')
      expect((error as SearchError).message).toContain('permission denied')
    }
  })

  it('refuses to report a capture that was cut short', () => {
    expect(() => assertSearchSucceeded(
      'findFiles',
      { ...base, exitCode: 0, stdoutTruncated: true },
      1000,
    )).toThrow(/byte cap/)
  })
})

function fakeProcess(result: Partial<ProcessResult> = {}): {
  execution: ExecutionProvider
  calls: Array<{ argv: readonly string[]; cwd: string }>
} {
  const calls: Array<{ argv: readonly string[]; cwd: string }> = []
  return {
    calls,
    execution: {
      async runShell() {
        throw new Error('unexpected shell call')
      },
      async runProcess(request) {
        calls.push({ argv: request.argv, cwd: request.cwd })
        return {
          exitCode: 0,
          stdout: '',
          stderr: '',
          stdoutTruncated: false,
          ...result,
        }
      },
      async fetchHttp() {
        throw new Error('unexpected network call')
      },
    },
  }
}

describe('RipgrepSearch.resolve* fills every default explicitly', () => {
  it('resolves an absent root to the workspace and fills the capability defaults', () => {
    const provider = new RipgrepSearch(
      new Context(),
      { cwd: process.cwd() },
    )

    const spec = provider.resolveFindFiles({ pattern: '**/*.ts' })
    expect(spec).toMatchObject({
      root: '.',
      pattern: '**/*.ts',
      maxResults: 200,
      respectGitignore: true,
      timeoutMs: 30_000,
    })
    expect(spec.excludes).toContain('node_modules')
    expect(spec.signal).toBeUndefined()
  })

  it('normalizes a rooted path and carries the caller signal through', () => {
    const provider = new RipgrepSearch(
      new Context(),
      { cwd: process.cwd() },
    )

    const controller = new AbortController()
    const spec = provider.resolveSearchText({
      pattern: 'value',
      path: './docs/adr/',
      glob: '**/*.md',
      maxResults: 5,
      signal: controller.signal,
    })
    expect(spec).toMatchObject({
      root: 'docs/adr',
      glob: '**/*.md',
      maxResults: 5,
    })
    expect(spec.signal).toBe(controller.signal)
  })

  it('rejects a search root that escapes the workspace', () => {
    const provider = new RipgrepSearch(
      new Context(),
      { cwd: process.cwd() },
    )

    expect(() => provider.resolveFindFiles({ pattern: '**', path: '../outside' }))
      .toThrow(/SEARCH_INVALID_PATH|inside the workspace/)
  })
})

describe('RipgrepSearch runs through the execution boundary', () => {
  it('spawns the resolved binary with the spec as argv and caps', async () => {
    const { execution, calls } = fakeProcess({ stdout: 'src\\a.ts\n' })
    const provider = new RipgrepSearch(
      new Context(),
      { cwd: process.cwd(), ripgrepPath: process.execPath, execution },
    )

    const result = await provider.findFiles(provider.resolveFindFiles({ pattern: '**/*.ts' }))
    expect(result).toEqual({ paths: ['src/a.ts'], truncated: false })
    expect(calls[0]!.argv[0]).toBe(process.execPath)
    expect(calls[0]!.argv).toContain('--files')
    expect(calls[0]!.cwd).toBe(process.cwd())
  })

  it('reports a truncated result when the cap cuts the list', async () => {
    const { execution } = fakeProcess({ stdout: 'a.ts\nb.ts\nc.ts\n' })
    const provider = new RipgrepSearch(
      new Context(),
      { cwd: process.cwd(), ripgrepPath: process.execPath, execution },
    )

    const result = await provider.findFiles(
      provider.resolveFindFiles({ pattern: '**/*.ts', maxResults: 2 }),
    )
    expect(result).toEqual({ paths: ['a.ts', 'b.ts'], truncated: true })
  })
})
