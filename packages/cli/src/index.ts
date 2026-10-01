import {
  CliError,
  formatAgentRun,
  runAgentCommand,
} from './commands.js'
import { startWebServer } from './server.js'
export * from './profile.js'
export * from './profile-file.js'

export type {
  AgentRuntime,
  AgentRuntimeOptions,
  LlmEnvConfig,
  RunAgentCommandOptions,
  RunAgentCommandResult,
} from './commands.js'
export {
  CliError,
  createAgentRuntime,
  formatAgentRun,
  resolveLlmEnv,
  runAgentCommand,
} from './commands.js'
export { parseYaml } from './yaml.js'
export { effectiveApiKey } from './config.js'
export { startWebServer } from './server.js'
export { ProjectHost } from './project-host.js'
export type {
  OpenProject,
  ProjectHostOptions,
  ProjectSnapshot,
  ProjectThreadDetail,
} from './project-host.js'
export type { WebServer, WebServerOptions } from './server.js'

export function main(argv: readonly string[]): Promise<number> {
  return (async () => {
    const [command, ...args] = argv
    if (command === 'run') {
      const parsed = parseRunAgentArgs(args)
      if (!parsed.prompt) throw new CliError('run requires a prompt')
      const result = await runAgentCommand({
        prompt: parsed.prompt,
        ...(parsed.cwd ? { cwd: parsed.cwd } : {}),
        ...(parsed.sessionFile ? { sessionFile: parsed.sessionFile } : {}),
        ...(parsed.configFile ? { configFile: parsed.configFile } : {}),
        ...(parsed.profile ? { profile: parsed.profile } : {}),
        ...(parsed.model ? { model: parsed.model } : {}),
        ...(parsed.baseUrl ? { baseUrl: parsed.baseUrl } : {}),
        ...(parsed.maxTokens !== undefined ? { maxTokens: parsed.maxTokens } : {}),
        ...(parsed.temperature !== undefined ? { temperature: parsed.temperature } : {}),
        ...(parsed.maxTurns !== undefined ? { maxTurns: parsed.maxTurns } : {}),
        ...(parsed.maxSteps !== undefined ? { maxSteps: parsed.maxSteps } : {}),
        ...(parsed.allowNetwork !== undefined ? { allowNetwork: parsed.allowNetwork } : {}),
        ...(parsed.allowShell !== undefined ? { allowShell: parsed.allowShell } : {}),
        ...(parsed.timeoutMs !== undefined ? { timeoutMs: parsed.timeoutMs } : {}),
        ...(parsed.maxRetries !== undefined ? { maxRetries: parsed.maxRetries } : {}),
        ...(parsed.retryDelayMs !== undefined
          ? { retryDelayMs: parsed.retryDelayMs }
          : {}),
      })
      return emit(formatAgentRun(result), 0)
    }

    if (command === 'web') {
      const parsed = parseWebArgs(args)
      const server = await startWebServer({
        ...(parsed.host ? { host: parsed.host } : {}),
        ...(parsed.port !== undefined ? { port: parsed.port } : {}),
        ...(parsed.configFile ? { configFile: parsed.configFile } : {}),
      })
      process.stdout.write(`tnega web listening on ${server.url}\n`)
      return new Promise<number>(() => {})
    }

    throw new CliError(`unknown command: ${command ?? '<empty>'}`)
  })().catch((error: unknown) => {
    if (error instanceof CliError) return emit(`error: ${error.message}`, 2)
    return emit(`error: ${error instanceof Error ? error.message : String(error)}`, 2)
  })
}

interface ParsedRunAgentArgs {
  prompt?: string
  cwd?: string
  sessionFile?: string
  configFile?: string
  profile?: string
  model?: string
  baseUrl?: string
  maxTokens?: number
  temperature?: number
  maxTurns?: number
  maxSteps?: number
  allowNetwork?: boolean
  allowShell?: boolean
  timeoutMs?: number
  maxRetries?: number
  retryDelayMs?: number
}

interface ParsedWebArgs {
  host?: string
  port?: number
  configFile?: string
}

function parseRunAgentArgs(args: readonly string[]): ParsedRunAgentArgs {
  const parsed: ParsedRunAgentArgs = {}
  const positional: string[] = []
  let cursor = 0
  while (cursor < args.length) {
    const arg = args[cursor]!
    if (!arg.startsWith('--')) {
      positional.push(arg)
      cursor += 1
      continue
    }
    if (arg === '--allow-network') {
      parsed.allowNetwork = true
      cursor += 1
      continue
    }
    if (arg === '--allow-shell') {
      parsed.allowShell = true
      cursor += 1
      continue
    }
    if (arg === '--profile') {
      const value = args[cursor + 1]
      if (!value) throw new CliError('--profile requires a value')
      parsed.profile = value
      cursor += 2
      continue
    }

    const eq = arg.indexOf('=')
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2)
    const value = eq >= 0 ? arg.slice(eq + 1) : args[cursor + 1]
    if (!value) throw new CliError(`--${name} requires a value`)
    assignRunAgentOption(parsed, name, value)
    cursor += eq >= 0 ? 1 : 2
  }

  const prompt = positional.join(' ').trim()
  if (prompt) parsed.prompt = prompt
  return parsed
}

function assignRunAgentOption(
  parsed: ParsedRunAgentArgs,
  name: string,
  value: string,
): void {
  switch (name) {
    case 'cwd':
      parsed.cwd = value
      return
    case 'session':
      parsed.sessionFile = value
      return
    case 'config':
    case 'config-file':
      parsed.configFile = value
      return
    case 'profile':
      parsed.profile = value
      return
    case 'model':
      parsed.model = value
      return
    case 'base-url':
      parsed.baseUrl = value
      return
    case 'max-tokens':
      parsed.maxTokens = parseFiniteNumber('--max-tokens', value)
      return
    case 'temperature':
      parsed.temperature = parseFiniteNumber('--temperature', value)
      return
    case 'max-turns':
      parsed.maxTurns = parseFiniteNumber('--max-turns', value)
      return
    case 'max-steps':
      parsed.maxSteps = parseFiniteNumber('--max-steps', value)
      return
    case 'timeout-ms':
      parsed.timeoutMs = parseFiniteNumber('--timeout-ms', value)
      return
    case 'max-retries':
      parsed.maxRetries = parseFiniteNumber('--max-retries', value)
      return
    case 'retry-delay-ms':
      parsed.retryDelayMs = parseFiniteNumber('--retry-delay-ms', value)
      return
    default:
      throw new CliError(`unknown option: --${name}`)
  }
}

function parseFiniteNumber(name: string, value: string): number {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new CliError(`${name} requires a finite number`)
  return number
}

function parseWebArgs(args: readonly string[]): ParsedWebArgs {
  const parsed: ParsedWebArgs = {}
  let cursor = 0
  while (cursor < args.length) {
    const arg = args[cursor]!
    if (arg === '--host' || arg === '--port' || arg === '--config' || arg === '--config-file') {
      const value = args[cursor + 1]
      if (!value) throw new CliError(`${arg} requires a value`)
      if (arg === '--host') parsed.host = value
      if (arg === '--port') parsed.port = parseFiniteNumber('--port', value)
      if (arg === '--config' || arg === '--config-file') parsed.configFile = value
      cursor += 2
      continue
    }
    throw new CliError(`unknown option: ${arg}`)
  }
  return parsed
}

function emit(output: string, code: number): number {
  process.stdout.write(`${output}\n`)
  return code
}

export const name = '@tnega/cli'
