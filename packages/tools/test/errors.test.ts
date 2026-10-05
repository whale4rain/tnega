import { describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { closestToolNames, describeParameters, toToolError, tools, type ToolsService } from '../src/index.js'

async function service(): Promise<ToolsService> {
  const root = new Context()
  await root.plugin(tools)
  const registry: ToolsService = root.get('tools')
  registry.register({
    schema: {
      name: 'read_file',
      description: 'read',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, offset: { type: 'integer' }, mode: { enum: ['text', 'bytes'] } },
        required: ['path'],
      },
    },
    execute: input => input,
  })
  registry.register({ schema: { name: 'shell', description: 'run' }, execute: () => '' })
  return registry
}

describe('tool failure text', () => {
  it('follows the cause chain a fetch failure hides', () => {
    const dns = Object.assign(new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com'), { code: 'ENOTFOUND' })
    const error = toToolError(new TypeError('fetch failed', { cause: dns }))
    expect(error.name).toBe('TypeError')
    expect(error.message).toBe('fetch failed: getaddrinfo ENOTFOUND raw.githubusercontent.com')
  })

  it('keeps system codes and names every error of an aggregate', () => {
    const refused = (address: string) => Object.assign(new Error(`connect ECONNREFUSED ${address}`), { code: 'ECONNREFUSED' })
    const error = toToolError(new AggregateError([refused('::1:80'), refused('127.0.0.1:80')], ''))
    expect(error.message).toBe('connect ECONNREFUSED ::1:80; connect ECONNREFUSED 127.0.0.1:80')
    expect(toToolError(Object.assign(new Error('open failed'), { code: 'EACCES' })).message).toBe('open failed (EACCES)')
  })

  it('never reports an empty reason or [object Object]', () => {
    expect(toToolError(new Error('')).message).toBe('Error')
    expect(toToolError({ status: 500 }).message).toBe('{"status":500}')
    expect(toToolError({ message: 'quota exceeded' }).message).toBe('quota exceeded')
    expect(toToolError(undefined).message).toBe('the tool failed without a reason')
  })

  it('suggests the tool a misspelled name meant', async () => {
    const registry = await service()
    await expect(registry.execute('readfile', {})).rejects.toThrow('tool not found: readfile. Did you mean read_file?')
    await expect(registry.execute('browser_open', {})).rejects.toThrow('Available tools: read_file, shell')
    expect(closestToolNames('Shell', ['shell', 'spawn_subagent'])).toEqual(['shell'])
  })

  it('names the tool, the problem and the expected shape for bad arguments', async () => {
    const registry = await service()
    const missing = await registry.execute('read_file', { offset: 1 })
    expect(missing.error?.message).toBe('invalid arguments for read_file: missing required property: path. Expected read_file(path: string, offset?: integer, mode?: "text" | "bytes")')
    const truncated = await registry.execute('read_file', '{"path": "a.ts", "offset": ')
    expect(truncated.error?.message).toMatch(/^invalid arguments for read_file: the arguments were not valid JSON \(.+\)\. Expected read_file\(/)
    expect(describeParameters('now', { type: 'object', properties: {} })).toBe('now({})')
  })
})
