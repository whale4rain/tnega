import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DAEMON_ALLOW_WS_ENV, DAEMON_TOKEN_ENV, httpOrigin, parseDaemonArgs, redeemPairing } from '../src/daemon-command.js'
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

  it('never prints control characters the agent chose', () => {
    const line = describeAction({ op: 'launch', app: 'x\r\u001b[2Ktnega daemon: computer use PAUSED' })
    expect(line.includes('\r') || line.includes('\u001b')).toBe(false)
    expect(line).toBe('start x??[2Ktnega daemon: computer use PAUSED')
    expect(describeAction({ op: 'menu', windowId: 1, path: ['a'.repeat(200)] })).toMatch(/^menu a{80}\.\.\. in window 1$/u)
    expect(describeAction({ op: 'key', windowId: 1, keys: ['ctrl', '\u009b2J'] })).toBe('press ctrl+?2J in window 1')
  })

  it('refuses to start without a server, with both a code and a token, or with an unknown option', () => {
    expect(() => parseDaemonArgs(['--token', 'x'], {})).toThrow(/--server/)
    expect(() => parseDaemonArgs(['--server', 'wss://t.example', '--pair', 'C', '--token', 'x'], {})).toThrow(/not both/)
    expect(() => parseDaemonArgs(['--server', 'wss://t.example', '--token', 'x', '--bogus'], {})).toThrow(/unknown option/)
  })

  it('takes a pairing code, and plain ws:// only when the server asked for it', () => {
    const parsed = parseDaemonArgs(['--server', 'wss://t.example/daemon', '--pair', 'ABCD-EFGH'], {})
    expect(parsed.pair).toBe('ABCD-EFGH')
    expect(parsed.token).toBeUndefined()
    expect(parsed.allowPlain).toBeUndefined()
    expect(parseDaemonArgs(['--server', 'ws://10.0.0.5:7777/daemon', '--token', 'x'], { [DAEMON_ALLOW_WS_ENV]: '1' }).allowPlain).toBe(true)
  })

  it('trades a pairing code for a daemon token at the server', async () => {
    expect(httpOrigin(new URL('wss://t.example/daemon'))).toBe('https://t.example')
    expect(httpOrigin(new URL('ws://localhost:7777/daemon'))).toBe('http://localhost:7777')
    const seen: Array<{ url: string; body: unknown; client: string | null }> = []
    const fakeFetch: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers)
      seen.push({ url: String(input), body: JSON.parse(String(init?.body)), client: headers.get('x-tnega-client') })
      return Response.json({ token: 'tnd_new' })
    }
    expect(await redeemPairing(new URL('wss://t.example/daemon'), 'ABCD', 'laptop', fakeFetch)).toBe('tnd_new')
    expect(seen).toEqual([{ url: 'https://t.example/api/auth/pair', body: { code: 'ABCD', purpose: 'daemon', device: 'laptop' }, client: '1' }])
    const refusing: typeof fetch = async () => Response.json({ error: 'code is not valid' }, { status: 401 })
    await expect(redeemPairing(new URL('wss://t.example/daemon'), 'BAD', 'laptop', refusing)).rejects.toThrow(/refused the pairing code: code is not valid/)
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
