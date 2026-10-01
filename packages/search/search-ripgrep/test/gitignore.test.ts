import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { RipgrepSearch } from '../src/index.js'
import { globMatcher, relativeToRoot } from '../src/glob.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('globMatcher', () => {
  it('anchors patterns to the search root with the documented wildcards', () => {
    const cases: Array<[string, string, boolean]> = [
      ['*.ts', 'a.ts', true],
      ['*.ts', 'src/a.ts', false],
      ['**/*.ts', 'a.ts', true],
      ['**/*.ts', 'src/deep/a.ts', true],
      ['src/*.ts', 'src/a.ts', true],
      ['src/*.ts', 'src/deep/a.ts', false],
      ['packages/*/README.md', 'packages/core/README.md', true],
      ['{a,b}.md', 'b.md', true],
      ['{a,b}.md', 'c.md', false],
      ['?op.ts', 'top.ts', true],
      ['[ab].md', 'a.md', true],
      ['[!ab].md', 'c.md', true],
      ['/docs/**', 'docs/adr/x.md', true],
      ['**', 'anything/at/all.txt', true],
      ['a.b', 'axb', false],
    ]
    for (const [pattern, path, expected] of cases) expect([pattern, path, globMatcher(pattern)(path)]).toEqual([pattern, path, expected])
  })

  it('makes paths relative to the search root', () => {
    expect(relativeToRoot('docs/adr/x.md', 'docs/adr')).toBe('x.md')
    expect(relativeToRoot('x.md', '.')).toBe('x.md')
  })
})

describe('ripgrep provider honours .gitignore even with a pattern', () => {
  async function workspace(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'tnega-rg-ignore-'))
    dirs.push(dir)
    await mkdir(join(dir, 'src'))
    await writeFile(join(dir, '.gitignore'), '*.log\ndist/\n')
    await writeFile(join(dir, 'kept.md'), 'needle\n')
    await writeFile(join(dir, 'ignored.log'), 'needle\n')
    await writeFile(join(dir, 'src', 'deep.log'), 'needle\n')
    await writeFile(join(dir, 'src', 'code.ts'), 'needle\n')
    await mkdir(join(dir, 'dist'))
    await writeFile(join(dir, 'dist', 'code.ts'), 'needle\n')
    return dir
  }

  it('does not let findFiles patterns pull in ignored files', async () => {
    const cwd = await workspace()
    const search = new RipgrepSearch(new Context(), { cwd })
    const find = async (pattern: string, path?: string) =>
      (await search.findFiles(search.resolveFindFiles({ pattern, ...(path ? { path } : {}) }))).paths.sort()
    expect(await find('**')).toEqual(['.gitignore', 'kept.md', 'src/code.ts'])
    expect(await find('**/*.log')).toEqual([])
    expect(await find('**/*.ts')).toEqual(['src/code.ts'])
    expect(await find('*.ts', 'src')).toEqual(['src/code.ts'])
    expect(await find('*')).toEqual(['.gitignore', 'kept.md'])
  })

  it('does not let grep globs pull in ignored files', async () => {
    const cwd = await workspace()
    const search = new RipgrepSearch(new Context(), { cwd })
    const grep = async (glob?: string) => (await search.searchText(search.resolveSearchText({ pattern: 'needle', ...(glob ? { glob } : {}) })))
      .matches.map(match => match.file).sort()
    expect(await grep('**/*.log')).toEqual([])
    expect(await grep('**/*.ts')).toEqual(['src/code.ts'])
    expect(await grep()).toEqual(['kept.md', 'src/code.ts'])
  })

  it('still lists ignored files when gitignore is switched off', async () => {
    const cwd = await workspace()
    const search = new RipgrepSearch(new Context(), { cwd, respectGitignore: false })
    expect((await search.findFiles(search.resolveFindFiles({ pattern: '**/*.log' }))).paths.sort()).toEqual(['ignored.log', 'src/deep.log'])
  })
})
