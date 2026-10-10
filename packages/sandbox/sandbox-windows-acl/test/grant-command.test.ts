/**
 * helper 进程协议：发布形态的 helper 解析、参数与回传的编解码，以及 {@link AclWriteGrant}
 * 把每一次授予/撤销交给注入的执行者（Provider 用它把整树传播挪出自己的进程）。
 *
 * 打包后的 helper 在任何平台都能跑一遍：非 Windows 宿主上它加载绑定失败，正好验证
 * 「失败经 JSON 回传、退出码非零、调用方还原出错误」这条 fail-closed 链路。
 */

import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

import { __setWin32BindingsForTest } from '../src/ffi.js'
import { parseGrantCommandArgs } from '../src/grant-command.js'
import type { AclOperation, GrantProcessResult } from '../src/grant-command.js'
import { AclWriteGrant, Win32Error, grantCommandArgs, parseGrantReply, resolveGrantCommand } from '../src/index.js'
import { createFakeWin32 } from './support/fake-win32.js'

const scratchDirs: string[] = []

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tnega-acl-grant-cmd-'))
  scratchDirs.push(dir)
  return dir
}

afterEach(() => {
  __setWin32BindingsForTest(undefined)
})

afterAll(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const grant: AclOperation = { kind: 'grant', path: 'C:\\workspace', writeSid: 'S-1-4-1-2' }

describe('resolveGrantCommand', () => {
  it('finds the published helper beside the module', () => {
    const dir = scratchDir()
    writeFileSync(join(dir, 'sandbox-windows-acl-grant.js'), '// fixture\n')
    expect(resolveGrantCommand({ moduleUrl: pathToFileURL(join(dir, 'main.js')) }))
      .toEqual([process.execPath, join(dir, 'sandbox-windows-acl-grant.js')])
  })

  it('reports no helper in a source checkout, so grants stay in-process', () => {
    expect(resolveGrantCommand({ moduleUrl: pathToFileURL(join(scratchDir(), 'main.js')) })).toBeUndefined()
    expect(resolveGrantCommand()).toBeUndefined()
  })
})

describe('helper arguments', () => {
  it('round-trips an operation', () => {
    expect(parseGrantCommandArgs(grantCommandArgs(grant))).toEqual(grant)
  })

  it('rejects anything else', () => {
    expect(parseGrantCommandArgs(['delete', 'C:\\x', 'S-1-4-1-2'])).toBeUndefined()
    expect(parseGrantCommandArgs(['grant', 'C:\\x'])).toBeUndefined()
    expect(parseGrantCommandArgs(['grant', '', 'S-1-4-1-2'])).toBeUndefined()
  })
})

describe('parseGrantReply', () => {
  const result = (exitCode: number, stdout: string, stderr = ''): GrantProcessResult => ({ exitCode, stdout, stderr })

  it('returns the operation value on success', () => {
    expect(parseGrantReply(result(0, '{"ok":true,"value":false}\n'), grant)).toBe(false)
  })

  it('restores a Win32 failure with its API name and code', () => {
    const reply = JSON.stringify({ ok: false, message: 'SetNamedSecurityInfoW failed (Win32 5): grantWrite(C:\\workspace)', api: 'SetNamedSecurityInfoW', win32Code: 5 })
    let thrown: unknown
    try {
      parseGrantReply(result(1, `${reply}\n`), grant)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Win32Error)
    expect(thrown).toMatchObject({ api: 'SetNamedSecurityInfoW', win32Code: 5, message: 'SetNamedSecurityInfoW failed (Win32 5): grantWrite(C:\\workspace)' })
  })

  it('fails closed when the helper dies without a result', () => {
    expect(() => parseGrantReply(result(3, '', 'Error: Cannot find module'), grant))
      .toThrow(/grant helper exited 3 without a result for C:\\workspace: Error: Cannot find module/u)
    expect(() => parseGrantReply(result(1, '{"ok":true,"value":true}'), grant)).toThrow(/exited 1 without a result/u)
  })
})

describe('AclWriteGrant with an injected operation runner', () => {
  it('routes every grant and revoke to the runner instead of the calling thread', async () => {
    const fake = createFakeWin32()
    __setWin32BindingsForTest(fake.bindings)
    const operations: AclOperation[] = []
    const aclGrant = await AclWriteGrant.create('S-1-4-4242-9', {
      operate: async (operation) => {
        operations.push(operation)
        await new Promise(resolve => setTimeout(resolve, 5))
        return true
      },
    })
    await aclGrant.add('C:\\workspace')
    await aclGrant.add('C:\\temp\\private', { revocable: true })
    await aclGrant.revoke('C:\\workspace')
    await aclGrant.dispose()

    expect(operations).toEqual([
      { kind: 'grant', path: 'C:\\workspace', writeSid: 'S-1-4-4242-9' },
      { kind: 'grant', path: 'C:\\temp\\private', writeSid: 'S-1-4-4242-9' },
      { kind: 'revoke', path: 'C:\\workspace', writeSid: 'S-1-4-4242-9' },
      { kind: 'revoke', path: 'C:\\temp\\private', writeSid: 'S-1-4-4242-9' },
    ])
    expect(fake.calls).not.toContain('lockFileEx')
    expect(fake.calls).not.toContain('setNamedSecurityInfoW')
    expect(fake.calls).toContain('localFree') // SID 仍由本进程释放
  })

  it('surfaces a runner failure from add', async () => {
    __setWin32BindingsForTest(createFakeWin32().bindings)
    const aclGrant = await AclWriteGrant.create('S-1-4-4242-10', {
      operate: () => Promise.reject(new Win32Error('LockFileEx', 33, 'still held')),
    })
    await expect(aclGrant.add('C:\\workspace')).rejects.toThrow(/LockFileEx failed \(Win32 33\)/u)
  })
})

describe.skipIf(process.platform === 'win32')('the bundled helper', () => {
  it('reports a load failure as a JSON reply and a non-zero exit', async () => {
    const dir = scratchDir()
    const outfile = join(dir, 'sandbox-windows-acl-grant.js')
    await build({
      entryPoints: [fileURLToPath(new URL('../src/grant-entry.ts', import.meta.url))],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node22',
      external: ['koffi'],
      logLevel: 'silent',
    })
    const command = resolveGrantCommand({ moduleUrl: pathToFileURL(join(dir, 'main.js')) })
    if (command === undefined) throw new Error('the helper was just built')

    const run = (args: readonly string[]) => new Promise<GrantProcessResult>((resolve) => {
      execFile(command[0] ?? '', [...command.slice(1), ...args], (error, stdout, stderr) => {
        resolve({ exitCode: error === null ? 0 : typeof error.code === 'number' ? error.code : -1, stdout, stderr })
      })
    })

    const loaded = await run(grantCommandArgs(grant))
    expect(loaded.exitCode).toBe(1)
    expect(() => parseGrantReply(loaded, grant)).toThrow(/only available on win32 hosts/u)

    const usage = await run(['grant'])
    expect(usage.exitCode).toBe(1)
    expect(() => parseGrantReply(usage, grant)).toThrow(/usage: <grant\|revoke>/u)
  }, 30_000)
})
