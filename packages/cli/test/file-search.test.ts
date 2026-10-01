import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { rankFiles, searchWorkspaceFiles } from '../src/file-search.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('rankFiles', () => {
  const files = ['src/report-builder.ts', 'outputs/q2-sales-report.docx', 'docs/reports/old.md', 'README.md', 'src/sales.ts']

  it('prefers file-name prefixes, then names, then paths, then loose matches', () => {
    expect(rankFiles(files, 'report', 10)).toEqual(['src/report-builder.ts', 'outputs/q2-sales-report.docx', 'docs/reports/old.md'])
    expect(rankFiles(files, 'sales', 10)).toEqual(['src/sales.ts', 'outputs/q2-sales-report.docx'])
    expect(rankFiles(files, 'q2rep', 10)).toEqual(['outputs/q2-sales-report.docx'])
    expect(rankFiles(files, 'OUTPUTS\\Q2', 10)).toEqual(['outputs/q2-sales-report.docx'])
  })

  it('keeps the original order for an empty query and respects the limit', () => {
    expect(rankFiles(files, '', 2)).toEqual(files.slice(0, 2))
    expect(rankFiles(files, 'zzz', 10)).toEqual([])
  })
})

describe('searchWorkspaceFiles', () => {
  it('lists workspace files, honouring .gitignore', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'tnega-file-search-'))
    dirs.push(workspace)
    await mkdir(join(workspace, 'outputs'))
    await mkdir(join(workspace, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(join(workspace, 'outputs', 'summary.xlsx'), 'x')
    await writeFile(join(workspace, 'notes.md'), 'x')
    await writeFile(join(workspace, 'secret.log'), 'x')
    await writeFile(join(workspace, '.gitignore'), '*.log\n')
    await writeFile(join(workspace, 'node_modules', 'pkg', 'index.js'), 'x')
    const files = await searchWorkspaceFiles(workspace, '', 50)
    expect(files).toEqual(expect.arrayContaining(['outputs/summary.xlsx', 'notes.md']))
    expect(files).not.toContain('secret.log')
    expect(files.some(file => file.startsWith('node_modules/'))).toBe(false)
    expect(await searchWorkspaceFiles(workspace, 'summ', 5)).toEqual(['outputs/summary.xlsx'])
  })
})
