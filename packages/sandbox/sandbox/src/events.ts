import type { Context } from '@tnega/core'
import {
  SandboxError,
  type ConfinedArgv,
  type RunnerFailureRule,
  type SandboxConfinedEvent,
  type SandboxEnforcement,
  type SandboxErrorCode,
  type SandboxErrorEvent,
  type SandboxOp,
  type SandboxPolicy,
  type SandboxPreConfineEvent,
} from './types.js'

/**
 * sandbox 缝的事件面：派发与形状校验。事件名与负载类型由本包（Service Definition）
 * 拥有，`SandboxService.confine` 的模板方法负责派发，所以任何 Provider 都自动参与
 * 全部事件，既不需要知道事件名，也无法绕过它们 —— 换 Provider 不会改变可观测的事件
 * 序列。
 *
 * | 事件 | 派发方式 | 作用 |
 * |---|---|---|
 * | `sandbox/pre-confine` | `waterfallAsync` | 收紧策略或改写 argv（策略）；不交出合法事件即失败 |
 * | `sandbox/confined` | `parallel` | 事后通知（审计、UI），成功包装后派发 |
 * | `sandbox/error` | `parallel` | 事后通知，任何失败（含 fail closed）时派发 |
 *
 * 改写点遵循 core 的 waterfall 约定（与 `agent/pre-step`、`tools/pre-execute`、
 * `search/pre-search` 一致）：**监听器就地改写负载，然后调用无参的 `next()`**。
 * 不调用 `next()` 表示拒绝这一步，沙箱以 `SANDBOX_INVALID_POLICY` 失败，绝不会被
 * 静默跳过 —— 一个说不清楚话的策略监听器不能变成一次不受限执行。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string')
}

function isOp(value: unknown): value is SandboxOp {
  return value === 'shell' || value === 'process'
}

function isEnforcement(value: unknown): value is SandboxEnforcement {
  return value === 'full' || value === 'partial'
}

/** 策略形状：模式必须是可强制的两种之一，根必须是绝对路径。 */
export function isSandboxPolicy(value: unknown): value is SandboxPolicy {
  if (!isRecord(value)) return false
  return (value.mode === 'read-only' || value.mode === 'workspace-write')
    && typeof value.workspaceRoot === 'string'
    && (value.tempRoot === undefined || typeof value.tempRoot === 'string')
}

/** 受限 argv 形状：调用方会直接 spawn 它，所以每一项都要能过。 */
export function isConfinedArgv(value: unknown): value is ConfinedArgv {
  if (!isRecord(value)) return false
  return isStringArray(value.argv) && value.argv.length > 0
    && typeof value.runner === 'string' && value.runner.length > 0
    && isEnforcement(value.enforcement)
    && isStringArray(value.denialSignatures)
    && Array.isArray(value.runnerFailureRules)
    && value.runnerFailureRules.every(isRunnerFailureRule)
}

function isRunnerFailureRule(value: unknown): value is RunnerFailureRule {
  if (!isRecord(value)) return false
  return isStringArray(value.fatalSignatures)
    && (value.allowedExitCodes === undefined
      || (Array.isArray(value.allowedExitCodes)
        && value.allowedExitCodes.every(code => typeof code === 'number')))
    && (value.informationalLines === undefined || isStringArray(value.informationalLines))
}

function isPreEvent(value: unknown): value is SandboxPreConfineEvent {
  return isRecord(value) && isOp(value.op) && isStringArray(value.argv)
    && isSandboxPolicy(value.policy)
}

/**
 * 派发 `sandbox/pre-confine`，返回监听器就地改写后的请求。
 *
 * @throws SandboxError `SANDBOX_INVALID_POLICY`：监听器没有把事件交给下一层，或改写出
 * 的策略/argv 形状非法。
 */
export async function preConfine(
  ctx: Context,
  event: SandboxPreConfineEvent,
): Promise<SandboxPreConfineEvent> {
  const resolved = await ctx.waterfallAsync(
    'sandbox/pre-confine',
    event,
    async (payload: SandboxPreConfineEvent) => payload,
  )
  if (!isPreEvent(resolved)) {
    throw new SandboxError(
      'sandbox/pre-confine did not forward a valid policy and argv',
      'SANDBOX_INVALID_POLICY',
    )
  }
  return { op: resolved.op, argv: [...resolved.argv], policy: resolved.policy }
}

/** 事后通知 `sandbox/confined`；观察者失败不影响受限 argv 的权威性。 */
export async function notifyConfined(ctx: Context, event: SandboxConfinedEvent): Promise<void> {
  try {
    await ctx.parallel('sandbox/confined', event)
  } catch {
    // 只读观察：观察者失败不改写权威结论。
  }
}

/** 事后通知 `sandbox/error`；观察者失败不取代原始的 `SANDBOX_*` 错误码。 */
export async function notifyError(ctx: Context, event: SandboxErrorEvent): Promise<void> {
  try {
    await ctx.parallel('sandbox/error', event)
  } catch {
    // 只读观察：观察者失败不改写权威结论。
  }
}

/** 把任意抛出物归一成事件负载里的 `error` 字段。 */
export function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** 取出 `SANDBOX_*` 错误码；非本缝的错误没有码。 */
export function sandboxErrorCode(error: Error): SandboxErrorCode | undefined {
  return error instanceof SandboxError ? error.code : undefined
}
