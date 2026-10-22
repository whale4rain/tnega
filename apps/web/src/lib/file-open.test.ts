import { describe, expect, test } from 'vitest'
import { absolutePath, fileOpenKind, fileUrl } from './file-open'

describe('fileOpenKind', () => {
  test('sends HTML to the browser and Markdown to the rendered view', () => {
    expect(fileOpenKind('site/index.html')).toBe('page')
    expect(fileOpenKind('OLD.HTM')).toBe('page')
    expect(fileOpenKind('docs/README.md')).toBe('markdown')
    expect(fileOpenKind('notes.markdown')).toBe('markdown')
  })

  test('keeps office files, PDFs and images in preview tabs and everything else in Files', () => {
    expect(fileOpenKind('report.docx')).toBe('preview')
    expect(fileOpenKind('a.pdf')).toBe('preview')
    expect(fileOpenKind('shot.PNG')).toBe('preview')
    expect(fileOpenKind('src/app.ts')).toBe('text')
    expect(fileOpenKind('Makefile')).toBe('text')
    expect(fileOpenKind('page.html.bak')).toBe('text')
  })
})

describe('fileUrl', () => {
  test('joins a POSIX workspace and a relative path', () => {
    expect(fileUrl('/home/me/site/', 'pages/index.html')).toBe('file:///home/me/site/pages/index.html')
  })

  test('keeps the Windows drive and turns backslashes into slashes', () => {
    expect(fileUrl('C:\\Users\\me\\site', 'pages\\index.html')).toBe('file:///C:/Users/me/site/pages/index.html')
    expect(fileUrl('d:/work', 'a.html')).toBe('file:///D:/work/a.html')
  })

  test('encodes spaces, # and ? in names', () => {
    expect(fileUrl('/tmp/my site', 'a #1?.html')).toBe('file:///tmp/my%20site/a%20%231%3F.html')
  })
})

describe('absolutePath', () => {
  test('uses the workspace separator', () => {
    expect(absolutePath('/home/me/site', 'docs/a.md')).toBe('/home/me/site/docs/a.md')
    expect(absolutePath('C:\\work\\', 'docs/a.md')).toBe('C:\\work\\docs\\a.md')
  })
})
