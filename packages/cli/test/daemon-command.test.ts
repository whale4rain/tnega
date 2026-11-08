import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DAEMON_TOKEN_ENV, parseDaemonArgs } from '../src/daemon-command.js'
import { main as runExecutable } from '../src/entry.js'

describe('tnega daemon', () => {
  it('reads the server, token and workspaces, defaulting to this folder', () => {
    expect(parseDaemonArgs(['--server', 'wss://t.example/daemon', '--token=abc'], {})).toEqual({
      server: 'wss://t.example/daemon',
      token: 'abc',
      workspaces: [resolve(process.cwd())],
    })
    const parsed = parseDaemonArgs(['--server', 'wss://t.example', '--workspace', 'a', '--workspace', 'b'], { [DAEMON_TOKEN_ENV]: 'from-env' })
    expect(parsed.token).toBe('from-env')
    expect(parsed.workspaces).toEqual([resolve('a'), resolve('b')])
  })

  it('serves a browser only when asked, and --browser takes no value', () => {
    expect(parseDaemonArgs(['--server', 'wss://t.example', '--token', 'x'], {}).browser).toBeUndefined()
    expect(parseDaemonArgs(['--server', 'wss://t.example', '--token', 'x', '--browser'], {}).browser).toBe(true)
    expect(() => parseDaemonArgs(['--server', 'wss://t.example', '--token', 'x', '--browser=yes'], {})).toThrow(/takes no value/)
  })

  it('refuses to start without a server or a token, or with an unknown option', () => {
    expect(() => parseDaemonArgs(['--token', 'x'], {})).toThrow(/--server/)
    expect(() => parseDaemonArgs(['--server', 'wss://t.example'], {})).toThrow(/--token/)
    expect(() => parseDaemonArgs(['--server', 'wss://t.example', '--token', 'x', '--bogus'], {})).toThrow(/unknown option/)
  })

  it('will not send its token over plain ws:// to another machine', async () => {
    const written: string[] = []
    const write = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string) => { written.push(String(chunk)); return true }) as typeof process.stdout.write
    try {
      expect(await runExecutable(['daemon', '--server', 'ws://t.example/daemon', '--token', 'secret'])).toBe(2)
    } finally {
      process.stdout.write = write
    }
    expect(written.join('')).toMatch(/refusing ws:/)
  })

  it('has its own help', async () => {
    const written: string[] = []
    const write = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string) => { written.push(String(chunk)); return true }) as typeof process.stdout.write
    try {
      expect(await runExecutable(['help', 'daemon'])).toBe(0)
    } finally {
      process.stdout.write = write
    }
    expect(written.join('')).toMatch(/tnega daemon --server/)
  })
})
