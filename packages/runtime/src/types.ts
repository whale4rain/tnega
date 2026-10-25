import type {
  AgentContextBudget,
  AgentDefinition,
  AgentInbox,
  DurableInbox,
  LLMAdapter,
} from '@tnega/agent'
import type { Context, Plugin } from '@tnega/core'
import type { LoopGuardConfig } from '@tnega/loop-guard'
import type { PtcRuntimeQuickjsConfig } from '@tnega/ptc-runtime-quickjs'
import type { SandboxMode } from '@tnega/sandbox'
import type { ToolPolicy } from '@tnega/tools'
import type { BuiltinToolsConfig } from './builtins.js'

/**
 * A named composition: the bundles to mount, plus defaults the caller may
 * override. Loading and booting live in `@tnega/profile`; the shape lives here
 * so a profile never has to import the runtime that consumes it.
 */
export interface AgentProfile {
  name: string
  bundles: readonly Plugin[]
  options?: Omit<AgentRuntimeOptions, 'cwd' | 'sessionFile' | 'plugins'>
}

/** One assembled Agent scope: a Session, the capability slice, and the role plugins. */
export interface AgentRuntimeOptions {
  cwd: string
  sessionFile: string
  /**
   * Stable identity this scope's one Agent answers to. Defaults to the session
   * file's name: a run that resumes the same file keeps the same id, which is
   * what the loop guard and the continuation nudge key their state on.
   */
  agentId?: string
  profile?: AgentProfile
  llm?: LLMAdapter
  contextWindow?: number
  inbox?: AgentInbox
  allowNetwork?: boolean
  allowShell?: boolean
  /**
   * 本机沙箱的模式。缺省按「有 shell 就至少要能写工作区」推导：`allowShell` 时是
   * `workspace-write`，否则 `read-only`。宿主上没有任何可用后端时 shell 会 fail
   * closed（拒绝执行），而不是悄悄退回非受限执行。
   */
  sandboxMode?: SandboxMode
  /** How strictly a file write must match what this Session already read. */
  fsGuard?: 'off' | 'warn' | 'enforce'
  maxTurns?: number
  maxSteps?: number
  contextBudget?: AgentContextBudget
  /**
   * Compact automatically past the model window instead of failing the request.
   * Defaults to on when an LLM adapter and a context window are known.
   */
  autoCompact?: boolean
  /** Watch turns for stalls (nudge, reflect, park). Defaults to on. */
  loopGuard?: boolean | LoopGuardConfig
  /** Steer a turn that stopped mid-task one more step. Defaults to on. */
  continuation?: boolean
  agent?: AgentDefinition
  toolPolicy?: ToolPolicy
  builtinTools?: false | BuiltinToolsConfig
  /** Defaults to enabled with builtin tools; explicitly enable for custom compositions. */
  jobs?: boolean
  /** Defaults to enabled with builtin tools; installs offline user skills. */
  skills?: boolean
  plugins?: readonly Plugin[]
  /** Web per-run agents consume durable steering at model step boundaries. */
  durableInbox?: boolean
  ptc?: { mode?: 'native' | 'both' | 'ptc'; timeoutMs?: number; memoryLimitBytes?: number }
  /** Host-provided runtime assets and limits; independent of model-visible PTC mode. */
  ptcRuntime?: PtcRuntimeQuickjsConfig
  /** Mount the office tools; defaults to `auto`, i.e. only when the workspace has one. */
  office?: boolean | 'auto'
}

export interface AgentRuntime {
  root: Context
  inbox?: DurableInbox
  dispose: () => Promise<void>
}
