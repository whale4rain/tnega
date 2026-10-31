import type { Context, Plugin } from '@tnega/core'
import { systemPrompt } from '@tnega/agent'
import { skillTools } from '@tnega/coding-agent'
import { localExecutionProvider } from '@tnega/execution'
import { secretEnvExecution } from '@tnega/execution-secrets'
import { sandboxedExecution } from '@tnega/execution-sandbox'
import { computerCua } from '@tnega/computer-cua'
import { jobsLocal } from '@tnega/jobs-local'
import { memoryLocal } from '@tnega/memory-local'
import { ptcRuntimeQuickjs, type PtcRuntimeQuickjsConfig } from '@tnega/ptc-runtime-quickjs'
import { networkPolicy } from '@tnega/execution'
import { canonicalPath, resolveSandboxPolicy, type SandboxExecutionPolicy, type SandboxNetworkRequest } from '@tnega/sandbox'
import { sandboxLocal } from '@tnega/sandbox-local'
import { searchRipgrep } from '@tnega/search-ripgrep'
import { secretsLocal, type SecretVault } from '@tnega/secrets-local'
import type { SessionLog } from '@tnega/session'
import { spillLocal } from '@tnega/spill-local'
import { runSummary } from '@tnega/run-summary'
import { loopGuard, type LoopGuardConfig } from '@tnega/loop-guard'
import { toolComputer } from '@tnega/tool-computer'
import { toolJobs } from '@tnega/tool-jobs'
import { toolMemory } from '@tnega/tool-memory'
import { toolOffice } from '@tnega/tool-office'
import { toolPtc } from '@tnega/tool-ptc'
import { toolSearch } from '@tnega/tool-search'
import { toolSecrets } from '@tnega/tool-secrets'
import { toolSpill } from '@tnega/tool-spill'
import { NetworkGrants, toolNetworkAccess, withGrants } from '@tnega/tool-network-access'
import { tools, type ToolPolicy } from '@tnega/tools'
import { builtinTools, type BuiltinToolsConfig } from './builtins.js'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { PermissionMode } from '@tnega/approval-host'
import { workspacePrompt } from '@tnega/workspace-prompt'

/**
 * Composition of one Agent scope.
 *
 * The capability slice — sandbox, builtin tools, search, spill, office, skills,
 * memory — used to be copied into the CLI runtime, the resident runtime, the
 * Project host and every Project thread. It lives here once, as plugins that
 * mount their Provider and their model-facing Consumer together:
 *
 * ```text
 * @tnega/sandbox-local ─→ capability:sandbox ─→ @tnega/execution-sandbox
 * @tnega/search-ripgrep ─→ capability:search ─→ @tnega/tool-search
 * @tnega/spill-local ─→ capability:spill ─→ @tnega/tool-spill
 * @tnega/secrets-local ─→ capability:secrets ─→ @tnega/execution-secrets, @tnega/tool-secrets
 * @tnega/computer-cua ─→ capability:computer ─→ @tnega/tool-computer
 * ```
 *
 * A caller only states what its role needs; adding a capability means adding
 * one entry here, not editing four composition roots.
 */

const OFFICE_EXTENSIONS = ['.xlsx', '.docx', '.pptx']
const SCAN_EXCLUDES = new Set(['node_modules', '.git', '.worktrees', '.pnpm-store', '.tnega', 'dist', 'out'])

/**
 * Whether a workspace holds Office files at all.
 *
 * Two levels deep, skipping the directories nobody keeps a deliverable in. The
 * four office tools cost more schema text than everything else in the CLI put
 * together, so they are mounted when there is something to open — or when the
 * caller says so, which is what a documents-oriented persona does.
 */
export async function hasOfficeFiles(workspace: string): Promise<boolean> {
  const walk = async (directory: string, depth: number): Promise<boolean> => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return false
    }
    for (const entry of entries) {
      if (entry.isFile() && OFFICE_EXTENSIONS.some(extension => entry.name.toLowerCase().endsWith(extension))) {
        return true
      }
      if (entry.isDirectory() && depth > 1 && !SCAN_EXCLUDES.has(entry.name)) {
        if (await walk(join(directory, entry.name), depth - 1)) return true
      }
    }
    return false
  }
  return await walk(workspace, 2)
}

/** A sandbox mode, or a resolver for a permission that can change per call. */
export type Permission = PermissionMode | (() => PermissionMode | Promise<PermissionMode>)

/**
 * Network access for sandboxed commands, or a resolver read before every
 * command so a change in Settings applies without restarting. Absent is open.
 */
export type SandboxNetworkSource =
  | SandboxNetworkRequest
  | (() => SandboxNetworkRequest | undefined | Promise<SandboxNetworkRequest | undefined>)
  | SandboxNetworkSettings

/** Command network settings a host can also write: "always allow" from an approval saves here. */
export interface SandboxNetworkSettings {
  read: () => SandboxNetworkRequest | undefined | Promise<SandboxNetworkRequest | undefined>
  remember?: (domains: readonly string[]) => Promise<void>
}

function isNetworkSettings(source: SandboxNetworkSource): source is SandboxNetworkSettings {
  return typeof source === 'object' && 'read' in source && typeof source.read === 'function'
}

async function networkOf(source: SandboxNetworkSource | undefined): Promise<SandboxNetworkRequest | undefined> {
  if (source === undefined) return undefined
  if (typeof source === 'function') return await source()
  return isNetworkSettings(source) ? await source.read() : source
}

export interface RuntimeSpec {
  workspace: string
  /** Sandbox mode for builtin tools. Defaults to `read-only`. */
  permission?: Permission
  /** Network access for sandboxed commands. Defaults to open. */
  sandboxNetwork?: SandboxNetworkSource
  /** Identity for the sandbox policy; defaults to the workspace. */
  sessionId?: string
  /** Tool registry policy (validation, authorization, truncation). */
  tools?: ToolPolicy
  /**
   * Builtin tool surface. `false` disables the sandbox and the capability
   * tools that depend on it; an object is forwarded as the tool config.
   */
  builtin?: BuiltinToolsConfig | false
  /** Mount the offline user-skill tools. Defaults to on with builtin tools. */
  skills?: boolean
  /** Mount search tools. Defaults to on with builtin tools. */
  search?: boolean
  /** Mount the tool-output spill policy. Defaults to on with builtin tools. */
  spill?: boolean
  /** Mount the office tools. Defaults to `auto`: only when the workspace holds one. */
  office?: boolean | 'auto'
  /** Mount the memory service and its tool. */
  memory?: boolean
  /** Mount the run summary tool. */
  summary?: boolean
  /**
   * Watch turns for stalls (repeats, cycles, no progress) instead of capping
   * their length; lifts the default step cap to a high backstop.
   */
  loopGuard?: boolean | LoopGuardConfig
  /** Mount background jobs; `provider: false` reuses an inherited registry. */
  jobs?: false | {
    provider?: boolean
    resolveSession?: (agentId?: string) => SessionLog | undefined
  }
  /** Mount the PTC runtime and its tool. */
  ptc?: false | {
    mode?: 'native' | 'both' | 'ptc'
    runtime?: PtcRuntimeQuickjsConfig
    resolveSession?: (agentId?: string) => SessionLog | undefined
  }
  /** Workspace whose user instructions feed the prompt; defaults to `workspace`. */
  promptWorkspace?: string
  /** Secrets the user gives this Session; without it, secret questions are refused. */
  secrets?: SecretsCapabilitySpec
  /** Let the agent see and use apps on this machine; only when the person turned it on. */
  computer?: ComputerCapabilitySpec
}

async function permissionOf(permission: Permission): Promise<PermissionMode> {
  return typeof permission === 'function' ? await permission() : permission
}

export interface SandboxCapabilitySpec {
  workspace: string
  permission: Permission
  network?: SandboxNetworkSource
  sessionId?: string
  builtin?: BuiltinToolsConfig
}

/**
 * Sandbox seam: pick the local provider, then hand the execution boundary to
 * the builtin tools. `shell` only knows the boundary it stands on, so pointing
 * the provider elsewhere moves it without touching the tool.
 */
export const sandboxCapability: Plugin = {
  name: 'capability:sandbox',
  inject: ['tools'],
  async apply(ctx: Context, spec: SandboxCapabilitySpec) {
    const workspaceRoot = canonicalPath(resolve(spec.workspace))
    await ctx.plugin(sandboxLocal, {
      workspaceRoot,
      // Allowed connections leave through the proxy set in Settings, else HTTPS_PROXY.
      upstreamProxy: () => networkPolicy().proxy,
    })
    // Domains the person approved through request_network_access, rebuilt from the Session.
    const grants = new NetworkGrants(() => ctx.get('session', false))
    const policy = async (): Promise<SandboxExecutionPolicy> => {
      const network = await withGrants(await networkOf(spec.network), grants)
      return resolveSandboxPolicy({
        mode: await permissionOf(spec.permission),
        workspaceRoot,
        sessionId: spec.sessionId ?? spec.workspace,
        ...(network !== undefined ? { network } : {}),
      })
    }
    await ctx.plugin(builtinTools, {
      ...(spec.builtin ?? {}),
      cwd: spec.workspace,
      execution: sandboxedExecution(ctx, {
        // Commands get this scope's secrets as variables when a store is mounted.
        inner: secretEnvExecution(ctx, localExecutionProvider),
        policy: await policy(),
        resolvePolicy: policy,
      }),
    })
    // Only hosts that read live settings (and so have a person to approve) get the tool.
    const source = spec.network
    if (source !== undefined && isNetworkSettings(source)) {
      await ctx.plugin(toolNetworkAccess, {
        grants,
        network: () => networkOf(source),
        ...(source.remember ? { remember: source.remember } : {}),
      })
    }
  },
}

export interface SecretsCapabilitySpec {
  /** The host's vault; it outlives this scope. */
  vault: SecretVault
  sessionId: string
}

/**
 * Secrets seam: the store bound to this Session, then the policy that masks
 * values in tool results. The command environment is wired by
 * `capability:sandbox`, which wraps its execution boundary.
 */
export const secretsCapability: Plugin = {
  name: 'capability:secrets',
  inject: ['tools'],
  async apply(ctx: Context, spec: SecretsCapabilitySpec & { workspace: string }) {
    await ctx.plugin(secretsLocal, { vault: spec.vault, workspace: spec.workspace, sessionId: spec.sessionId })
    await ctx.plugin(toolSecrets)
  },
}

export interface WorkspaceCapabilitySpec { workspace: string }

/** Search seam: provider then the model-facing `glob` / `grep`. */
export const searchCapability: Plugin = {
  name: 'capability:search',
  inject: ['tools'],
  async apply(ctx: Context, spec: WorkspaceCapabilitySpec) {
    await ctx.plugin(searchRipgrep, { cwd: spec.workspace })
    await ctx.plugin(toolSearch, { cwd: spec.workspace })
  },
}

/** Spill seam: a store to write to, then the post-execute policy that reads it. */
export const spillCapability: Plugin = {
  name: 'capability:spill',
  inject: ['tools'],
  async apply(ctx: Context, spec: WorkspaceCapabilitySpec) {
    await ctx.plugin(spillLocal, { cwd: spec.workspace })
    await ctx.plugin(toolSpill)
  },
}

export const officeCapability: Plugin = {
  name: 'capability:office',
  inject: ['tools'],
  async apply(ctx: Context, spec: WorkspaceCapabilitySpec) {
    await ctx.plugin(toolOffice, { cwd: spec.workspace })
  },
}

export const skillsCapability: Plugin = {
  name: 'capability:skills',
  inject: ['tools'],
  async apply(ctx: Context, spec: WorkspaceCapabilitySpec) {
    await ctx.plugin(skillTools, { cwd: spec.workspace })
  },
}

export interface MemoryCapabilitySpec { workspace: string; writeTool?: boolean }

export const memoryCapability: Plugin = {
  name: 'capability:memory',
  inject: ['tools'],
  async apply(ctx: Context, spec: MemoryCapabilitySpec) {
    await ctx.plugin(memoryLocal, { cwd: spec.workspace })
    await ctx.plugin(toolMemory, { writeTool: spec.writeTool !== false })
  },
}

export interface PtcCapabilitySpec {
  mode?: 'native' | 'both' | 'ptc'
  runtime?: PtcRuntimeQuickjsConfig
  resolveSession?: (agentId?: string) => SessionLog | undefined
}

/**
 * PTC runtime plus its model-facing `run_code`. Kept separate from the rest of
 * the slice because a caller may need to mount host/profile plugins first: a
 * failing PTC startup must still unwind whatever was mounted before it.
 */
export const ptcCapability: Plugin = {
  name: 'capability:ptc',
  inject: ['tools'],
  async apply(ctx: Context, spec: PtcCapabilitySpec) {
    await ctx.plugin(ptcRuntimeQuickjs, spec.runtime ?? {})
    await ctx.plugin(toolPtc, {
      mode: spec.mode ?? 'native',
      resolveSession: spec.resolveSession ?? (() => ctx.get('session', false)),
    })
  },
}

export interface ComputerCapabilitySpec {
  /** Path to the `cua-driver` binary; found on PATH or in the installer's folder otherwise. */
  driverPath?: string
  /** Screenshots one Session may take (see `ToolComputerConfig.maxScreenshots`). */
  maxScreenshots?: number
}

/**
 * Computer seam: cua-driver is the Provider, the `computer_*` tools the
 * Consumer. Mount it only when the person turned computer use on; the tools
 * ask for each app once per Session through the approval host.
 */
export const computerCapability: Plugin = {
  name: 'capability:computer',
  inject: ['tools'],
  async apply(ctx: Context, spec: ComputerCapabilitySpec) {
    await ctx.plugin(computerCua, spec.driverPath ? { driverPath: spec.driverPath } : {})
    await ctx.plugin(toolComputer, spec.maxScreenshots !== undefined ? { maxScreenshots: spec.maxScreenshots } : {})
  },
}

/**
 * The capability slice of one Agent scope, assembled from a spec.
 *
 * Mount it on the scope's own context — a Project thread passes the context it
 * isolated for that thread, so every provider lands in the thread's scope.
 */
export const runtimeCapabilities: Plugin = {
  name: 'runtime:capabilities',
  async apply(ctx: Context, spec: RuntimeSpec) {
    const builtinOn = spec.builtin !== false
    const office = spec.office ?? 'auto'
    const builtin = spec.builtin === false ? false : spec.builtin ?? {}
    await ctx.plugin(tools, spec.tools ?? {})
    await ctx.plugin(systemPrompt)
    await ctx.plugin(workspacePrompt, { workspace: spec.promptWorkspace ?? spec.workspace })
    if (spec.summary) await ctx.plugin(runSummary)
    if (spec.loopGuard) await ctx.plugin(loopGuard, spec.loopGuard === true ? {} : spec.loopGuard)

    if (spec.secrets) await ctx.plugin(secretsCapability, { ...spec.secrets, workspace: spec.workspace })
    if (builtinOn) {
      await ctx.plugin(sandboxCapability, {
        workspace: spec.workspace,
        permission: spec.permission ?? 'read-only',
        ...(spec.sessionId !== undefined ? { sessionId: spec.sessionId } : {}),
        ...(spec.sandboxNetwork !== undefined ? { network: spec.sandboxNetwork } : {}),
        ...(builtin ? { builtin } : {}),
      })
    }
    if (spec.search ?? builtinOn) await ctx.plugin(searchCapability, { workspace: spec.workspace })
    if (spec.spill ?? builtinOn) await ctx.plugin(spillCapability, { workspace: spec.workspace })
    if (office === true || (office === 'auto' && builtinOn && await hasOfficeFiles(spec.workspace))) {
      await ctx.plugin(officeCapability, { workspace: spec.workspace })
    }
    if (spec.skills ?? builtinOn) await ctx.plugin(skillsCapability, { workspace: spec.workspace })
    if (spec.memory) {
      await ctx.plugin(memoryCapability, { workspace: spec.workspace, writeTool: builtinOn })
    }

    if (spec.jobs) {
      if (spec.jobs.provider !== false) await ctx.plugin(jobsLocal)
      await ctx.plugin(toolJobs, {
        resolveSession: spec.jobs.resolveSession ?? (() => ctx.get('session', false)),
      })
    }
    if (spec.ptc) await ctx.plugin(ptcCapability, spec.ptc)
    if (spec.computer) await ctx.plugin(computerCapability, spec.computer)

    // Every executable tool is a schema provider, so the assembled prompt and
    // the registry can never disagree about what the model may call.
    const promptService = ctx.get('systemPrompt')
    const toolRegistry = ctx.get('tools')
    ctx.effect(() => promptService.registerTools(() => toolRegistry.list().map(tool => tool.schema)))
  },
}
