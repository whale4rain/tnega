import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@tnega/core'
import {
  builtinTools,
  createBuiltinToolDefinitions,
  type ExecutionProvider,
  tools,
  type BuiltinToolsConfig,
  type ToolResult,
  type ToolsService,
} from '../src/index.js'

const dirs: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function mount(config: BuiltinToolsConfig = {}): Promise<{
  service: ToolsService
  disposeBuiltins(): Promise<void>
}> {
  const root = new Context()
  await root.plugin(tools)
  const builtinsFiber = await root.plugin(builtinTools, config)
  const service = (root as unknown as { tools: ToolsService }).tools
  return {
    service,
    disposeBuiltins: () => builtinsFiber.dispose(),
  }
}

async function ok(
  service: ToolsService,
  name: string,
  input: unknown,
): Promise<unknown> {
  const result = await service.execute(name, input)
  expect(result.ok).toBe(true)
  return result.output
}

async function fail(
  service: ToolsService,
  name: string,
  input: unknown,
): Promise<ToolResult> {
  const result = await service.execute(name, input)
  expect(result.ok).toBe(false)
  return result
}

function names(service: ToolsService): string[] {
  return service.list().map(tool => tool.schema.name).sort()
}

describe('builtinTools plugin lifecycle', () => {
  it('registers the default minimal set and removes everything on unload', async () => {
    const { service, disposeBuiltins } = await mount()

    expect(names(service)).toEqual([
      'calculator',
      'echo',
      'glob',
      'grep',
      'json',
      'list_dir',
      'now',
      'read_file',
      'write_file',
    ])
    expect(service.has('http_get')).toBe(false)
    expect(service.has('shell')).toBe(false)

    await disposeBuiltins()
    expect(service.list()).toHaveLength(0)
  })

  it('honours the disabled list', async () => {
    const { service } = await mount({ disabled: ['calculator', 'json', 'read_file'] })

    expect(service.has('calculator')).toBe(false)
    expect(service.has('json')).toBe(false)
    expect(service.has('read_file')).toBe(false)
    expect(service.has('echo')).toBe(true)
  })

  it('keeps builtin tools isolated between scopes', async () => {
    const dirA = await tempDir('tnega-tools-a-')
    const dirB = await tempDir('tnega-tools-b-')
    const root = new Context()
    const scopeA = root.isolate('tools')
    const scopeB = root.isolate('tools')
    await scopeA.plugin(tools)
    await scopeB.plugin(tools)
    const fiberA = scopeA.plugin(builtinTools, { cwd: dirA })
    const fiberB = scopeB.plugin(builtinTools, { cwd: dirB })
    await Promise.all([fiberA, fiberB])
    const serviceA = (scopeA as unknown as { tools: ToolsService }).tools
    const serviceB = (scopeB as unknown as { tools: ToolsService }).tools

    await writeFile(join(dirA, 'only-a.txt'), 'a', 'utf8')
    await writeFile(join(dirB, 'only-b.txt'), 'b', 'utf8')
    const resultA = await serviceA.execute('read_file', { path: 'only-a.txt' })
    const resultB = await serviceB.execute('read_file', { path: 'only-b.txt' })
    expect(resultA.ok).toBe(true)
    expect(resultB.ok).toBe(true)

    const escape = await serviceB.execute('read_file', { path: '../tnega-tools-a-*' })
    expect(escape.ok).toBe(false)
    expect(escape.error?.message).toContain('escapes')

    await fiberA.dispose()
    expect(serviceA.has('read_file')).toBe(false)
    expect(serviceB.has('read_file')).toBe(true)
  })

  it('createBuiltinToolDefinitions returns schemas and optional tools from config', () => {
    const defaults = createBuiltinToolDefinitions()
    expect(defaults.map(tool => tool.schema.name)).toContain('echo')
    expect(defaults.some(tool => tool.schema.name === 'http_get')).toBe(false)

    const expanded = createBuiltinToolDefinitions({ allowNetwork: true, allowShell: true })
    const expandedNames = expanded.map(tool => tool.schema.name)
    expect(expandedNames).toContain('http_get')
    expect(expandedNames).toContain('shell')
  })
})

describe('execution provider seam', () => {
  it('routes shell tool execution through the injected provider', async () => {
    const calls: string[] = []
    const execution: ExecutionProvider = {
      async runShell(request) {
        calls.push(request.command)
        return { exitCode: 0, stdout: 'mocked', stderr: '' }
      },
      async fetchHttp() {
        throw new Error('unexpected network call')
      },
    }
    const dir = await tempDir('tnega-tools-exec-shell-')
    const shell = createBuiltinToolDefinitions({
      cwd: dir,
      allowShell: true,
      execution,
    }).find(tool => tool.schema.name === 'shell')!

    const result = await shell.execute({ command: 'echo hi' }, {})
    expect(calls).toEqual(['echo hi'])
    expect(result).toEqual({ exitCode: 0, stdout: 'mocked', stderr: '' })
  })

  it('routes http_get execution through the injected provider', async () => {
    const urls: string[] = []
    const execution: ExecutionProvider = {
      async runShell() {
        throw new Error('unexpected shell call')
      },
      async fetchHttp(request) {
        urls.push(request.url)
        return {
          status: 200,
          ok: true,
          headers: { 'content-type': 'text/plain' },
          body: 'mocked',
          truncated: false,
        }
      },
    }
    const dir = await tempDir('tnega-tools-exec-http-')
    const httpGet = createBuiltinToolDefinitions({
      cwd: dir,
      allowNetwork: true,
      execution,
    }).find(tool => tool.schema.name === 'http_get')!

    const result = await httpGet.execute({ url: 'https://example.com/a' }, {})
    expect(urls).toEqual(['https://example.com/a'])
    expect(result).toMatchObject({ status: 200, body: 'mocked' })
  })
})

describe('computation tools', () => {
  it('echo returns text and now returns a parseable timestamp', async () => {
    const { service } = await mount()
    expect(await ok(service, 'echo', { text: 'hello' })).toBe('hello')

    const timestamp = String(await ok(service, 'now', {}))
    expect(new Date(timestamp).toISOString()).toBe(timestamp)
  })

  it('calculator evaluates precedence, unary minus and functions', async () => {
    const { service } = await mount()
    expect(await ok(service, 'calculator', { expression: '2 + 3 * 4' })).toBe(14)
    expect(await ok(service, 'calculator', { expression: '-2^2' })).toBe(-4)
    expect(await ok(service, 'calculator', { expression: 'sqrt(16) + pow(2, 3)' })).toBe(12)
    expect(await ok(service, 'calculator', { expression: 'max(1, 5, 3) - min(2, 4)' })).toBe(3)
  })

  it('calculator reports invalid expressions as tool errors', async () => {
    const { service } = await mount()
    const empty = await fail(service, 'calculator', { expression: '' })
    expect(empty.error?.message).toContain('empty expression')

    const divide = await fail(service, 'calculator', { expression: '1 / 0' })
    expect(divide.error?.message).toContain('division by zero')

    const unknown = await fail(service, 'calculator', { expression: 'wat(1)' })
    expect(unknown.error?.message).toContain('unknown function')
  })
})

describe('json tool', () => {
  it('parses, stringifies and gets values by path', async () => {
    const { service } = await mount()
    expect(await ok(service, 'json', {
      operation: 'parse',
      value: '{"a": [1, 2]}',
    })).toEqual({ a: [1, 2] })
    expect(await ok(service, 'json', {
      operation: 'stringify',
      value: { a: 1 },
      space: 2,
    })).toBe('{\n  "a": 1\n}')

    const value = { a: { b: [10, 20] }, 'x-y': 3 }
    expect(await ok(service, 'json', {
      operation: 'get',
      value,
      path: 'a.b[1]',
    })).toBe(20)
    expect(await ok(service, 'json', {
      operation: 'get',
      value,
      path: '["x-y"]',
    })).toBe(3)
  })

  it('reports invalid JSON and missing paths', async () => {
    const { service } = await mount()
    const invalid = await fail(service, 'json', {
      operation: 'parse',
      value: '{bad',
    })
    expect(invalid.error?.message).toContain('invalid JSON')

    const missing = await fail(service, 'json', {
      operation: 'get',
      value: { a: 1 },
      path: 'a.b',
    })
    expect(missing.error?.message).toContain('json path not found')
  })
})

describe('file tools', () => {
  it('writes, appends, reads and lists files inside the workspace', async () => {
    const dir = await tempDir('tnega-tools-files-')
    const { service } = await mount({ cwd: dir })

    const written = await ok(service, 'write_file', {
      path: 'notes/a.txt',
      content: 'first',
    })
    expect(written).toMatchObject({ path: 'notes/a.txt', bytes: 5, appended: false })

    await ok(service, 'write_file', {
      path: 'notes/a.txt',
      content: '+second',
      append: true,
    })
    const read = await ok(service, 'read_file', { path: 'notes/a.txt' }) as {
      path: string
      bytes: number
      content: string
    }
    expect(read.content).toBe('first+second')
    expect(read.bytes).toBe(12)

    const entries = await ok(service, 'list_dir', { recursive: true }) as Array<{
      path: string
      type: string
    }>
    expect(entries).toContainEqual({ name: 'notes', path: 'notes', type: 'directory' })
    expect(entries).toContainEqual({ name: 'a.txt', path: 'notes/a.txt', type: 'file' })

    const onDisk = await readFile(join(dir, 'notes', 'a.txt'), 'utf8')
    expect(onDisk).toBe('first+second')
  })

  it('glob finds files and grep finds matching lines', async () => {
    const dir = await tempDir('tnega-tools-search-')
    const { service } = await mount({ cwd: dir })
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(dir, 'src'), { recursive: true })
    await writeFile(join(dir, 'src', 'a.ts'), 'export const value = 1\n', 'utf8')
    await writeFile(join(dir, 'README.md'), '# hello\nvalue: 2\n', 'utf8')

    const matched = await ok(service, 'glob', { pattern: '**/*.ts' }) as string[]
    expect(matched.sort()).toEqual(['src/a.ts'])

    const grep = await ok(service, 'grep', { pattern: 'value' }) as Array<{
      file: string
      line: number
      text: string
    }>
    expect(grep).toContainEqual({ file: 'src/a.ts', line: 1, text: 'export const value = 1' })
    expect(grep).toContainEqual({ file: 'README.md', line: 2, text: 'value: 2' })

    const filtered = await ok(service, 'grep', {
      pattern: 'value',
      glob: '**/*.md',
    }) as Array<{ file: string }>
    expect(filtered.map(item => item.file)).toEqual(['README.md'])
  })

  it('rejects paths that escape the workspace', async () => {
    const dir = await tempDir('tnega-tools-escape-')
    const outside = await tempDir('tnega-tools-outside-')
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8')
    const { service } = await mount({ cwd: dir })

    const absolute = await fail(service, 'read_file', {
      path: join(outside, 'secret.txt'),
    })
    expect(absolute.error?.message).toContain('escapes')

    const relative = await fail(service, 'read_file', {
      path: join('..', 'secret.txt'),
    })
    expect(relative.error?.message).toContain('escapes')

    const writeEscape = await fail(service, 'write_file', {
      path: join('..', 'escaped.txt'),
      content: 'nope',
    })
    expect(writeEscape.error?.message).toContain('escapes')
  })

  it('rejects binary files and byte limits', async () => {
    const dir = await tempDir('tnega-tools-limits-')
    const { service } = await mount({ cwd: dir, maxWriteBytes: 4 })
    await writeFile(join(dir, 'binary.dat'), Buffer.from([0, 1, 2, 3]))
    await writeFile(join(dir, 'long.txt'), '1234567890', 'utf8')

    const binary = await fail(service, 'read_file', { path: 'binary.dat' })
    expect(binary.error?.message).toContain('binary')

    const tooLarge = await fail(service, 'read_file', { path: 'long.txt', maxBytes: 4 })
    expect(tooLarge.error?.message).toContain('exceeds')

    const writeTooLarge = await fail(service, 'write_file', {
      path: 'big.txt',
      content: 'hello',
    })
    expect(writeTooLarge.error?.message).toContain('exceeds')
  })
})

describe('network and shell tools', () => {
  it('keeps http_get and shell hidden unless explicitly enabled', async () => {
    const { service } = await mount({ allowNetwork: true, allowShell: true })
    expect(service.has('http_get')).toBe(true)
    expect(service.has('shell')).toBe(true)
  })

  it('http_get fetches a URL and rejects unsupported protocols', async () => {
    const { service } = await mount({ allowNetwork: true })
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ hello: 'world' }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    ))
    vi.stubGlobal('fetch', fetchMock)

    const fetched = await ok(service, 'http_get', {
      url: 'https://example.test/data',
    }) as { status: number; ok: boolean; body: string }
    expect(fetched.status).toBe(200)
    expect(fetched.ok).toBe(true)
    expect(JSON.parse(fetched.body)).toEqual({ hello: 'world' })

    const badProtocol = await fail(service, 'http_get', {
      url: 'file:///etc/passwd',
    })
    expect(badProtocol.error?.message).toContain('unsupported protocol')
  })

  it('shell runs commands when enabled and reports exit codes', async () => {
    const dir = await tempDir('tnega-tools-shell-')
    const { service } = await mount({ cwd: dir, allowShell: true })

    const success = await ok(service, 'shell', { command: 'echo shell-ok' }) as {
      exitCode: number
      stdout: string
      stderr: string
    }
    expect(success.exitCode).toBe(0)
    expect(success.stdout.trim()).toBe('shell-ok')

    const failure = await ok(service, 'shell', {
      command: 'node -e "process.exit(3)"',
    }) as { exitCode: number }
    expect(failure.exitCode).toBe(3)

    const escape = await fail(service, 'shell', {
      command: 'echo nope',
      cwd: '..',
    })
    expect(escape.error?.message).toContain('escapes')
  })

  it('shell times out and kills the process tree', async () => {
    const dir = await tempDir('tnega-tools-shell-timeout-')
    const { service } = await mount({
      cwd: dir,
      allowShell: true,
      timeoutMs: 200,
    })
    const result = await fail(service, 'shell', {
      command: 'node -e "setInterval(() => {}, 1000)"',
      timeoutMs: 200,
    })
    expect(result.error?.message).toContain('timed out')
  })

  it('shell cancels when the run signal aborts', async () => {
    const dir = await tempDir('tnega-tools-shell-cancel-')
    const { service } = await mount({ cwd: dir, allowShell: true })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    const result = await service.execute(
      'shell',
      { command: 'node -e "setInterval(() => {}, 1000)"' },
      { signal: controller.signal },
    )
    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('cancelled')
  })
})
