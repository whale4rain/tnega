import type { Context } from '@tnega/core'
import { ProcessRegistry, type ExecutionProvider } from '@tnega/process'
import { localExecutionProvider } from '@tnega/process-local'
import type { WorkspaceFs } from '@tnega/fs'
import { LocalWorkspaceFs } from '@tnega/fs-local'
import { createFsTools, type FsGuardMode } from '@tnega/tool-fs'
import { createShellTool } from '@tnega/tool-shell'
import { createWebFetchTool } from '@tnega/tool-web-fetch'
import type { ToolDefinition } from '@tnega/tools'

/**
 * The default tool set of one workspace, as one composition setting.
 *
 * Each tool lives in its own domain package — files in `@tnega/tool-fs`,
 * `shell` in `@tnega/tool-shell`, `http_get` in `@tnega/tool-web-fetch` —
 * and this bundle only decides which of them a scope gets. Shell and network
 * stay explicit opt-ins.
 */
export interface BuiltinToolsConfig {
  cwd?: string
  /** Mount `http_get`. */
  allowNetwork?: boolean
  /** Mount `shell`. */
  allowShell?: boolean
  allowOutsideWorkspace?: boolean | (() => boolean | Promise<boolean>)
  allowPrivateNetwork?: boolean | (() => boolean | Promise<boolean>)
  /** Tool names to leave out. */
  disabled?: readonly string[]
  /** Byte cap for a fetched http body. */
  maxReadBytes?: number
  /** Byte cap for one write, and for captured shell output. */
  maxWriteBytes?: number
  /** Byte cap for one `read_file` result (reads are exempt from spill). */
  maxReadFileBytes?: number
  /** Lines one read returns unless it asks for fewer. */
  maxReadLines?: number
  /** Characters a long line keeps when a page has to be cut to fit. */
  maxLineChars?: number
  /** Declare `shell`'s `runInBackground` (honoured by the jobs plugin). */
  backgroundJobs?: boolean
  /** How strictly a write must match what this Agent already read of that path. */
  fsGuard?: FsGuardMode
  /** Most entries one `list_dir` returns. */
  maxResults?: number
  /** Default timeout of one shell command. */
  timeoutMs?: number
  /** Directory names a recursive `list_dir` skips. */
  searchExcludes?: readonly string[]
  /**
   * The execution boundary for `shell` and `http_get`. The plugin takes
   * `ctx.process` when a Provider is mounted; without one it is this machine.
   */
  execution?: ExecutionProvider
  /**
   * The workspace's file system. The plugin opens it from `ctx.fs` when a
   * Provider is mounted; without one (a bare test scope) it is this machine.
   */
  fs?: WorkspaceFs
  /** Background processes shared beyond this scope (see ProcessRegistry). */
  processes?: ProcessRegistry
}

function outsideOption(config: BuiltinToolsConfig): { allowOutside?: boolean | (() => boolean | Promise<boolean>) } {
  return config.allowOutsideWorkspace !== undefined ? { allowOutside: config.allowOutsideWorkspace } : {}
}

/** Build the default tools without registering them. */
export function createBuiltinToolDefinitions(
  config: BuiltinToolsConfig = {},
  /** A registry the caller owns and disposes, used when `config.processes` is absent. */
  ownedProcesses?: ProcessRegistry,
): ToolDefinition[] {
  const disabled = new Set(config.disabled ?? [])
  const files = config.fs ?? new LocalWorkspaceFs(config.cwd ?? process.cwd(), outsideOption(config))
  // Without a provided boundary (a bare scope or a test), commands run on this machine.
  const execution = config.execution ?? localExecutionProvider
  const definitions = createFsTools(files, {
    disabled: [...disabled],
    ...(config.maxReadFileBytes !== undefined ? { maxReadBytes: config.maxReadFileBytes } : {}),
    ...(config.maxWriteBytes !== undefined ? { maxWriteBytes: config.maxWriteBytes } : {}),
    ...(config.maxReadLines !== undefined ? { maxReadLines: config.maxReadLines } : {}),
    ...(config.maxLineChars !== undefined ? { maxLineChars: config.maxLineChars } : {}),
    ...(config.fsGuard !== undefined ? { fsGuard: config.fsGuard } : {}),
    ...(config.maxResults !== undefined ? { maxResults: config.maxResults } : {}),
    ...(config.searchExcludes !== undefined ? { searchExcludes: config.searchExcludes } : {}),
  })
  if (config.allowNetwork && !disabled.has('http_get')) {
    definitions.push(createWebFetchTool({
      ...(config.allowPrivateNetwork !== undefined ? { allowPrivateNetwork: config.allowPrivateNetwork } : {}),
      ...(config.maxReadBytes !== undefined ? { maxBytes: config.maxReadBytes } : {}),
      execution,
    }))
  }
  if (config.allowShell && !disabled.has('shell')) {
    definitions.push(createShellTool({
      ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
      // One fence for files and commands: a workspace on a daemon is fenced there, in its own path form.
      resolveCwd: path => files.resolve(path),
      ...(config.allowOutsideWorkspace !== undefined ? { allowOutsideWorkspace: config.allowOutsideWorkspace } : {}),
      ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
      ...(config.maxWriteBytes !== undefined ? { maxOutputBytes: config.maxWriteBytes } : {}),
      execution,
      ...(config.processes ? { processes: config.processes } : {}),
      ...(config.backgroundJobs !== undefined ? { backgroundJobs: config.backgroundJobs } : {}),
    }, ownedProcesses))
  }
  return definitions
}

/** Mount the default tools of one workspace on this scope's registry. */
export const builtinTools = {
  name: 'builtinTools',
  inject: ['tools'],
  apply(ctx: Context, config: BuiltinToolsConfig = {}) {
    // Without a shared registry, background processes die with this plugin.
    const owned = config.processes || !config.allowShell ? undefined : new ProcessRegistry()
    if (owned) ctx.fiber.effect(() => () => { void owned.dispose() }, 'builtinTools/processes')
    const provider = config.fs ? undefined : ctx.get('fs', false)
    const fs = provider?.workspace(config.cwd ?? process.cwd(), outsideOption(config))
    const execution = config.execution ?? ctx.get('process', false)
    const resolved = { ...config, ...fs ? { fs } : {}, ...execution ? { execution } : {} }
    for (const definition of createBuiltinToolDefinitions(resolved, owned)) ctx.tools.register(definition)
  },
}
