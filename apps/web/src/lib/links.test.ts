import { describe, expect, it } from 'vitest'
import { codePathTarget, linkTarget, workspaceRelative } from './links'

describe('link targets', () => {
  it('sends workspace files to the Workbench, with or without a line', () => {
    expect(linkTarget('src/app.ts')).toEqual({ kind: 'file', path: 'src/app.ts' })
    expect(linkTarget('./src/app.ts:42')).toEqual({ kind: 'file', path: 'src/app.ts', line: 42 })
    expect(linkTarget('src/app.ts#L7-L9')).toEqual({ kind: 'file', path: 'src/app.ts', line: 7 })
    expect(linkTarget('src/my%20file.md')).toEqual({ kind: 'file', path: 'src/my file.md' })
    expect(linkTarget(String.raw`D:\work\repo\src\a.ts:3`, 'D:/work/repo')).toEqual({ kind: 'file', path: 'src/a.ts', line: 3 })
    expect(linkTarget('file:///d:/work/repo/README.md', String.raw`D:\work\repo`)).toEqual({ kind: 'file', path: 'README.md' })
    expect(linkTarget('/etc/hosts', '/home/me/repo')).toEqual({ kind: 'other' })
  })

  it('keeps dev servers in the app and other sites in a new tab', () => {
    expect(linkTarget('http://localhost:5173/')).toEqual({ kind: 'local', url: 'http://localhost:5173/' })
    expect(linkTarget('http://0.0.0.0:3000/app')).toEqual({ kind: 'local', url: 'http://localhost:3000/app' })
    expect(linkTarget('https://example.com/docs')).toEqual({ kind: 'web', url: 'https://example.com/docs' })
    expect(linkTarget('mailto:a@b.c')).toEqual({ kind: 'other' })
    expect(linkTarget('#section')).toEqual({ kind: 'other' })
    expect(linkTarget('javascript:1;alert(1)')).toEqual({ kind: 'other' })
    expect(linkTarget('javascript:alert(1)//:1')).toEqual({ kind: 'other' })
  })

  it('links inline code only when it clearly names a file', () => {
    expect(codePathTarget('apps/web/src/App.tsx')).toEqual({ kind: 'file', path: 'apps/web/src/App.tsx' })
    expect(codePathTarget('server.ts:42')).toEqual({ kind: 'file', path: 'server.ts', line: 42 })
    for (const prose of ['Node.js', 'e.g.', 'v0.4.13', 'npm run dev', 'a.b', 'https://x.y/z.js']) expect(codePathTarget(prose)).toBeUndefined()
  })

  it('maps absolute paths inside the workspace only', () => {
    expect(workspaceRelative('/home/me/repo/a/b.ts', '/home/me/repo')).toBe('a/b.ts')
    expect(workspaceRelative('/home/me/repository/a.ts', '/home/me/repo')).toBeUndefined()
    expect(workspaceRelative('C:/Repo/x.ts', 'c:\\repo\\')).toBe('x.ts')
    expect(workspaceRelative('../outside.md', '/repo')).toBeUndefined()
    expect(workspaceRelative('/repo/../outside.md', '/repo')).toBeUndefined()
    expect(workspaceRelative('src/../docs/brief.md', '/repo')).toBe('docs/brief.md')
  })
})
