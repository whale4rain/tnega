import { describe, expect, it } from 'vitest'
import { availableShells, configureSystemShell, decodeOutput, describeShell, localExecutionProvider, resolveSystemShell, shellCommandArgv, systemShell } from '../src/index.js'

const has = (...paths: string[]) => (path: string) => paths.some(p => p.toLowerCase() === path.toLowerCase())

describe('resolveSystemShell', () => {
  it('finds Git Bash next to git on PATH when PowerShell is missing', () => {
    const shell = resolveSystemShell({
      platform: 'win32',
      env: { PATH: 'C:\\Tools\\Git\\cmd;C:\\Windows', SystemRoot: 'C:\\Windows' },
      exists: has('C:\\Tools\\Git\\cmd\\git.exe', 'C:\\Tools\\Git\\bin\\bash.exe'),
    })
    expect(shell).toMatchObject({ kind: 'bash', label: 'Git Bash', path: 'C:\\Tools\\Git\\bin\\bash.exe' })
  })

  it('prefers PowerShell 7, then Windows PowerShell, then cmd', () => {
    const env = { PATH: 'C:\\pwsh', SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\cmd.exe' }
    const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    expect(resolveSystemShell({ platform: 'win32', env, exists: has('C:\\pwsh\\pwsh.exe', ps) }).kind).toBe('pwsh')
    expect(resolveSystemShell({ platform: 'win32', env, exists: has(ps) }).kind).toBe('powershell')
    expect(resolveSystemShell({ platform: 'win32', env, exists: has() })).toMatchObject({ kind: 'cmd', path: 'C:\\Windows\\cmd.exe' })
  })

  it('uses $SHELL elsewhere and honours an explicit preference', () => {
    expect(resolveSystemShell({
      platform: 'win32',
      preferred: 'bash',
      env: { PATH: 'C:\\pwsh;C:\\Git\\cmd' },
      exists: has('C:\\pwsh\\pwsh.exe', 'C:\\Git\\cmd\\git.exe', 'C:\\Git\\bin\\bash.exe'),
    }).label).toBe('Git Bash')
    expect(resolveSystemShell({ platform: 'darwin', env: { SHELL: '/bin/zsh' }, exists: has('/bin/zsh') }).kind).toBe('zsh')
    expect(resolveSystemShell({ platform: 'linux', env: {}, exists: has() }).path).toBe('/bin/sh')
    expect(resolveSystemShell({
      platform: 'win32',
      preferred: 'pwsh',
      env: { PATH: 'C:\\pwsh;C:\\Git\\cmd' },
      exists: has('C:\\pwsh\\pwsh.exe', 'C:\\Git\\cmd\\git.exe', 'C:\\Git\\bin\\bash.exe'),
    }).kind).toBe('pwsh')
  })
})

describe('availableShells', () => {
  it('lists only shells present on the machine', () => {
    const shells = availableShells({
      platform: 'win32',
      env: { PATH: 'C:\\pwsh;C:\\Git\\cmd;C:\\Windows\\System32', SystemRoot: 'C:\\Windows' },
      exists: has('C:\\pwsh\\pwsh.exe', 'C:\\Git\\cmd\\git.exe', 'C:\\Git\\bin\\bash.exe', 'C:\\Windows\\System32\\cmd.exe'),
    })
    expect(shells.map(shell => shell.label)).toEqual(['PowerShell 7', 'Git Bash', 'cmd.exe'])
  })

  it('never offers the WSL bash launcher as a Windows shell', () => {
    const shells = availableShells({
      platform: 'win32',
      env: { PATH: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows' },
      exists: has('C:\\Windows\\System32\\bash.exe', 'C:\\Windows\\System32\\cmd.exe'),
    })
    expect(shells.map(shell => shell.path)).toEqual(['C:\\Windows\\System32\\cmd.exe'])
  })

  it('switches the process shell when the preference changes', () => {
    const detected = configureSystemShell(undefined)
    expect(configureSystemShell('  ')).toEqual(detected)
    expect(systemShell()).toEqual(detected)
  })
})

describe('shellCommandArgv', () => {
  it('passes the command as one argument, encoded for PowerShell', () => {
    expect(shellCommandArgv({ kind: 'bash', path: 'bash', label: 'bash' }, 'echo "a b"')).toEqual(['bash', '-c', 'echo "a b"'])
    const argv = shellCommandArgv({ kind: 'pwsh', path: 'pwsh', label: 'PowerShell 7' }, 'Write-Output "x"')
    const encoded = argv[argv.indexOf('-EncodedCommand') + 1] ?? ''
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toContain('Write-Output "x"')
    expect(describeShell({ kind: 'pwsh', path: 'pwsh', label: 'PowerShell 7' })).toContain('PowerShell syntax')
  })
})

describe('decodeOutput', () => {
  it('keeps UTF-8 whole even when a capture cuts a character in half', () => {
    const bytes = Buffer.from('ok 中文', 'utf8')
    expect(decodeOutput(bytes)).toBe('ok 中文')
    expect(decodeOutput(bytes.subarray(0, bytes.length - 1), 'linux')).toBe('ok 中')
  })

  it.runIf(process.platform === 'win32')('falls back to the OEM code page for non-UTF-8 Windows output', () => {
    const encoding = new TextDecoder('gbk')
    // GBK bytes for 中文: only meaningful on hosts whose OEM code page is 936.
    const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])
    expect(decodeOutput(gbk)).not.toContain('���')
    expect(encoding.decode(gbk)).toBe('中文')
  })
})

describe('local shell', () => {
  it('runs quoting, pipes and exit codes through the detected shell', async () => {
    const kind = systemShell().kind
    const command = kind === 'pwsh' || kind === 'powershell'
      ? 'Write-Output "a b" | ForEach-Object { $_.ToUpper() }; exit 3'
      : kind === 'cmd' ? 'echo A B& exit /b 3' : 'echo "a b" | tr a-z A-Z; exit 3'
    const result = await localExecutionProvider.runShell({ command, cwd: process.cwd(), timeoutMs: 20_000 })
    expect(result.stdout.trim()).toBe('A B')
    expect(result.exitCode).toBe(3)
  }, 30_000)
})
