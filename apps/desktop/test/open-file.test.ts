import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { launchesProgram, openWorkspaceFile, revealWorkspaceFile, workspaceFile, type FileShell } from '../src/open-file.js'

let root: string
let workspace: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tnega-open-file-'))
  workspace = join(root, 'ws')
  mkdirSync(join(workspace, 'docs'), { recursive: true })
  writeFileSync(join(workspace, 'docs', 'page.html'), '<p>hi</p>')
  writeFileSync(join(workspace, 'setup.exe'), '')
  writeFileSync(join(root, 'secret.txt'), 'outside')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 })
})

function fakeShell(error = ''): FileShell & { opened: string[], shown: string[] } {
  const opened: string[] = []
  const shown: string[] = []
  return {
    opened,
    shown,
    openPath: async path => { opened.push(path); return error },
    showItemInFolder: path => { shown.push(path) },
  }
}

describe('workspaceFile', () => {
  test('resolves a relative path inside the workspace', () => {
    expect(workspaceFile(workspace, 'docs/page.html')).toMatch(/page\.html$/)
  })

  test('refuses paths that leave the workspace, are missing or are not strings', () => {
    expect(workspaceFile(workspace, '../secret.txt')).toBeUndefined()
    expect(workspaceFile(workspace, join(root, 'secret.txt'))).toBeUndefined()
    expect(workspaceFile(workspace, 'docs/none.html')).toBeUndefined()
    expect(workspaceFile(workspace, '')).toBeUndefined()
    expect(workspaceFile('relative/ws', 'docs/page.html')).toBeUndefined()
    expect(workspaceFile(workspace, 42)).toBeUndefined()
  })

  test.skipIf(process.platform === 'win32')('refuses a symlink that points outside', () => {
    symlinkSync(join(root, 'secret.txt'), join(workspace, 'link.txt'))
    expect(workspaceFile(workspace, 'link.txt')).toBeUndefined()
  })
})

describe('launchesProgram', () => {
  test('knows what each system would run', () => {
    expect(launchesProgram('C:\\ws\\setup.EXE', 'win32')).toBe(true)
    expect(launchesProgram('C:\\ws\\tool.js', 'win32')).toBe(true)
    expect(launchesProgram('/ws/App.app', 'darwin')).toBe(true)
    expect(launchesProgram('/ws/run.command', 'darwin')).toBe(true)
    expect(launchesProgram('/ws/app.desktop', 'linux')).toBe(true)
    expect(launchesProgram('/ws/index.html', 'win32')).toBe(false)
    expect(launchesProgram('/ws/main.ts', 'darwin')).toBe(false)
    expect(launchesProgram('/ws/Makefile', 'linux')).toBe(false)
  })
})

describe('openWorkspaceFile', () => {
  test('opens a document with its default app', async () => {
    const shell = fakeShell()
    expect(await openWorkspaceFile(shell, workspace, 'docs/page.html', 'linux')).toBe('opened')
    expect(shell.opened).toHaveLength(1)
  })

  test('shows a program in the file manager instead of running it', async () => {
    const shell = fakeShell()
    expect(await openWorkspaceFile(shell, workspace, 'setup.exe', 'win32')).toBe('revealed')
    expect(shell.opened).toHaveLength(0)
    expect(shell.shown).toHaveLength(1)
  })

  test('reports a refused path or a failed open', async () => {
    expect(await openWorkspaceFile(fakeShell(), workspace, '../secret.txt', 'linux')).toBe('missing')
    expect(await openWorkspaceFile(fakeShell('no app'), workspace, 'docs/page.html', 'linux')).toBe('failed')
  })
})

describe('revealWorkspaceFile', () => {
  test('shows a workspace file and refuses one outside', () => {
    const shell = fakeShell()
    expect(revealWorkspaceFile(shell, workspace, 'docs/page.html')).toBe('revealed')
    expect(revealWorkspaceFile(shell, workspace, '../secret.txt')).toBe('missing')
    expect(shell.shown).toHaveLength(1)
  })
})
