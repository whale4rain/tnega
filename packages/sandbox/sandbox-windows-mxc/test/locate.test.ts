import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EXEC_ENV, locateMxcExecutor, resolveMxcRunnerCommand } from '../src/index.js'

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
