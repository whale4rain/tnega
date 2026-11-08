import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DAEMON_TOKEN_ENV, parseDaemonArgs } from '../src/daemon-command.js'
import { main as runExecutable } from '../src/entry.js'
import { computerSwitch, describeAction } from '../src/daemon-computer.js'

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

  it('offers computer use only when asked', () => {
    expect(parseDaemonArgs(['--server', 'wss://t.example', '--token', 'x'], {}).computer).toBeUndefined()
    expect(parseDaemonArgs(['--server', 'wss://t.example', '--token', 'x', '--computer'], {}).computer).toBe(true)
    expect(() => parseDaemonArgs(['--server', 'wss://t.example', '--token', 'x', '--computer=1'], {})).toThrow(/takes no value/)
  })

  it('shows computer use is on, each action without its text, and pauses on p', () => {
    const lines: string[] = []
    let press: (key: string) => void = () => {}
    let quit = 0
    const guard = computerSwitch({
      keys: listener => { press = listener; return () => { press = () => {} } },
      write: line => { lines.push(line) },
      onQuit: () => { quit++ },
    })
    expect(lines.join('\n')).toMatch(/computer use is ON/)
    expect(lines.join('\n')).toMatch(/press p to pause/)
    expect(guard.paused()).toBeUndefined()

    guard.onAction?.({ op: 'type', windowId: 3, text: 'my password' })
    expect(lines.at(-1)).toBe('tnega daemon: computer: type 11 characters in window 3')
    expect(lines.join('\n')).not.toContain('my password')

    press('p')
    expect(guard.paused()).toMatch(/paused/)
    expect(lines.at(-1)).toMatch(/PAUSED/)
    press('P')
    expect(guard.paused()).toBeUndefined()
    press('\u0003')
    expect(quit).toBe(1)
    guard.dispose()
  })

  it('says so when there is no terminal to pause from', () => {
    const lines: string[] = []
    computerSwitch({ write: line => { lines.push(line) }, onQuit: () => {} })
    expect(lines.at(-1)).toMatch(/stop the daemon to stop computer use/)
    expect(describeAction({ op: 'launch', app: 'notepad' })).toBe('start notepad')
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
