import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EXEC_ENV, locateMxcExecutor, mxcSetup, resolveMxcRunnerCommand } from '../src/index.js'

const present = (...paths: string[]) => (path: string) => paths.includes(path)
const noSdk = () => undefined

describe('locateMxcExecutor', () => {
  it('prefers the configured path and refuses one that does not exist', () => {
    expect(locateMxcExecutor({ configuredPath: 'C:\\mxc\\wxc-exec.exe', exists: present('C:\\mxc\\wxc-exec.exe'), env: {} }))
      .toBe('C:\\mxc\\wxc-exec.exe')
    expect(() => locateMxcExecutor({ configuredPath: 'C:\\nope.exe', exists: present(), env: {} }))
      .toThrow(/configured MXC executor does not exist/u)
  })

  it('then the environment variable', () => {
    expect(locateMxcExecutor({ env: { [EXEC_ENV]: '/x/wxc-exec.exe' }, exists: present('/x/wxc-exec.exe'), resolveSdkManifest: noSdk }))
      .toBe('/x/wxc-exec.exe')
    expect(() => locateMxcExecutor({ env: { [EXEC_ENV]: '/x/missing.exe' }, exists: present(), resolveSdkManifest: noSdk }))
      .toThrow(new RegExp(`${EXEC_ENV} does not exist`, 'u'))
  })

  it('then the SDK payload for this architecture, falling back to the other one', () => {
    const sdk = join('/sdk', 'package.json')
    const x64 = join('/sdk', 'bin', 'x64', 'wxc-exec.exe')
    const arm64 = join('/sdk', 'bin', 'arm64', 'wxc-exec.exe')
    expect(locateMxcExecutor({ env: {}, arch: 'arm64', exists: present(x64, arm64), resolveSdkManifest: () => sdk })).toBe(arm64)
    expect(locateMxcExecutor({ env: {}, arch: 'arm64', exists: present(x64), resolveSdkManifest: () => sdk })).toBe(x64)
  })

  it('then PATH, and names every way to supply it when nothing is found', () => {
    const onPath = join('/bin2', 'wxc-exec.exe')
    expect(locateMxcExecutor({ env: { PATH: ['/bin1', '/bin2'].join(delimiter) }, exists: present(onPath), resolveSdkManifest: noSdk }))
      .toBe(onPath)
    expect(() => locateMxcExecutor({ env: { PATH: '/bin1' }, exists: present(), resolveSdkManifest: noSdk }))
      .toThrow(/TNEGA_MXC_EXEC.*@microsoft\/mxc-sdk.*PATH/u)
  })
})

describe('resolveMxcRunnerCommand', () => {
  it('uses the published runner next to the bundle, then the source runner', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tnega-mxc-anchor-'))
    try {
      writeFileSync(join(dir, 'sandbox-windows-mxc-runner.js'), '')
      expect(resolveMxcRunnerCommand({ moduleUrl: pathToFileURL(join(dir, 'main.js')) }))
        .toEqual([process.execPath, join(dir, 'sandbox-windows-mxc-runner.js')])
      expect(resolveMxcRunnerCommand()[1]).toMatch(/runner\.ts$/u)
      expect(() => resolveMxcRunnerCommand({ moduleUrl: pathToFileURL(join(dir, 'sub', 'main.js')) }))
        .toThrow(/runner entry not found/u)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('takes an explicit override as is', () => {
    expect(resolveMxcRunnerCommand({ runnerCommand: ['node', 'r.js'] })).toEqual(['node', 'r.js'])
    expect(() => resolveMxcRunnerCommand({ runnerCommand: [] })).toThrow(/must not be empty/u)
  })
})

describe('global npm install', () => {
  it('finds the SDK installed with npm install -g', () => {
    const exec = join('C:\\Users\\u\\AppData\\Roaming', 'npm', 'node_modules', '@microsoft', 'mxc-sdk', 'bin', 'x64', 'wxc-exec.exe')
    expect(locateMxcExecutor({ env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, arch: 'x64', exists: present(exec), resolveSdkManifest: noSdk }))
      .toBe(exec)
  })

  it('follows the configured npm prefix, not only the default one', () => {
    const prefix = join('D:\\', 'node', 'npm_global')
    const exec = join(prefix, 'node_modules', '@microsoft', 'mxc-sdk', 'bin', 'x64', 'wxc-exec.exe')
    const found = { arch: 'x64', exists: present(exec), resolveSdkManifest: noSdk }
    expect(locateMxcExecutor({ env: { NPM_CONFIG_PREFIX: prefix }, ...found })).toBe(exec)
    expect(locateMxcExecutor({ env: { npm_config_prefix: prefix }, ...found })).toBe(exec)
  })

  it('reads the prefix off PATH, where the global bin directory lives', () => {
    const prefix = join('D:\\', 'node', 'npm_global')
    const exec = join(prefix, 'node_modules', '@microsoft', 'mxc-sdk', 'bin', 'x64', 'wxc-exec.exe')
    expect(locateMxcExecutor({
      env: { PATH: ['C:\\Windows', prefix].join(delimiter) },
      arch: 'x64',
      exists: present(exec),
      resolveSdkManifest: noSdk,
    })).toBe(exec)
  })

  it('also checks the parent of a POSIX <prefix>/bin entry', () => {
    const prefix = join('/usr', 'local', 'lib', 'nodejs')
    const exec = join(prefix, 'node_modules', '@microsoft', 'mxc-sdk', 'bin', 'x64', 'wxc-exec.exe')
    expect(locateMxcExecutor({
      env: { PATH: join(prefix, 'bin') },
      arch: 'x64',
      exists: present(exec),
      resolveSdkManifest: noSdk,
    })).toBe(exec)
  })
})

describe('mxcSetup', () => {
  const found = { exists: present('/x/wxc-exec.exe'), resolveSdkManifest: noSdk }
  it('only suggests MXC on Windows 11 24H2 or newer', () => {
    expect(mxcSetup({ platform: 'linux', release: '6.8.0', env: {}, ...found })).toBe('unsupported')
    expect(mxcSetup({ platform: 'win32', release: '10.0.22631', env: {}, ...found })).toBe('unsupported')
    expect(mxcSetup({ platform: 'win32', release: '10.0.26100', env: {}, ...found })).toBe('missing')
  })

  it('reports an installed or switched-off executor', () => {
    expect(mxcSetup({ platform: 'win32', release: '10.0.26200', env: { [EXEC_ENV]: '/x/wxc-exec.exe' }, ...found })).toBe('installed')
    expect(mxcSetup({ platform: 'win32', release: '10.0.26200', env: { [EXEC_ENV]: 'off' }, ...found })).toBe('disabled')
  })
})
