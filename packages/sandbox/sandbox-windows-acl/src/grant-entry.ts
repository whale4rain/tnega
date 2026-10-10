/**
 * DACL 授予/撤销的 helper 进程入口（协议见 `src/grant-command.ts`）。
 *
 * 只在发布形态里运行：构建把它打成与包入口同目录的 `sandbox-windows-acl-grant.js`。它加载
 * 绑定、转换 SID、执行一次 {@link grantWrite} / {@link revokeWrite}，在 stdout 写一行 JSON
 * 回传，然后退出。慢的那一步（整树继承传播）因此只占住这个进程，不占住 Provider 的进程。
 */

import { grantWrite, revokeWrite } from './acl.js'
import { throwLastError, throwWin32, win32 } from './ffi.js'
import { failureReply, parseGrantCommandArgs } from './grant-command.js'
import type { AclOperation, AclOperationReply } from './grant-command.js'

/**
 * 执行一次操作；SID 在本进程转换，用完释放。
 * @param operation - 命令行给出的操作。
 * @returns 操作的返回值。
 */
async function perform(operation: AclOperation): Promise<boolean> {
  const api = await win32()
  const sidSlot = api.allocPtrSlot()
  if (api.convertStringSidToSidW(operation.writeSid, sidSlot) === 0) {
    throwLastError(api, 'ConvertStringSidToSidW', operation.writeSid)
  }
  const sidPtr = api.decodePtr(sidSlot)
  if (sidPtr === null) {
    throwWin32(api, 'ConvertStringSidToSidW', api.getLastError(), `null SID for ${operation.writeSid}`)
  }
  try {
    if (operation.kind === 'grant') {
      grantWrite(api, operation.path, sidPtr)
      return true
    }
    return revokeWrite(api, operation.path, sidPtr)
  } finally {
    api.localFree(sidPtr) // 进程马上退出：尽力释放，不覆盖操作本身的结果或错误
  }
}

/** 写回传并设置退出码。 */
function report(reply: AclOperationReply): void {
  process.stdout.write(`${JSON.stringify(reply)}\n`)
  process.exitCode = reply.ok ? 0 : 1
}

const operation = parseGrantCommandArgs(process.argv.slice(2))
if (operation === undefined) {
  report({ ok: false, message: `usage: <grant|revoke> <path> <write SID>; got ${JSON.stringify(process.argv.slice(2))}` })
} else {
  perform(operation).then(value => report({ ok: true, value }), (error: unknown) => report(failureReply(error)))
}
