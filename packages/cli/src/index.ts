import type { CompareResult, EvalRun } from '@tnega/eval'
import {
  CliError,
  compareCommand,
  formatAgentRun,
  formatCompare,
  formatEvolveResult,
  formatRun,
  runAgentCommand,
  runCommand,
  runEvolveCommand,
} from './commands.js'

export type {
  EvolveFileConfig,
  LlmEnvConfig,
  RunAgentCommandOptions,
  RunAgentCommandResult,
  RunEvolveCommandOptions,
  RunEvolveCommandResult,
  TasksFile,
} from './commands.js'
export {
  CliError,
  compareCommand,
  formatAgentRun,
  formatCompare,
  formatEvolveResult,
  formatRun,
  loadTasksFile,
  resolveLlmEnv,
  runAgentCommand,
  runCommand,
  runEvolveCommand,
} from './commands.js'
export { parseYaml } from './yaml.js'
export type { CompareResult, EvalRun }

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

    if (command === 'eval' && args[0] === 'run') {
      const parsed = parseRunArgs(args.slice(1))
      if (!parsed.tasksFile) throw new CliError('eval run requires a tasks file')
      const run = await runCommand({
        tasksFile: parsed.tasksFile,
        ...(parsed.candidateName ? { candidateName: parsed.candidateName } : {}),
        ...(parsed.cache !== undefined ? { cache: parsed.cache } : {}),
        ...(parsed.outputFile ? { outputFile: parsed.outputFile } : {}),
        ...(parsed.cwd ? { cwd: parsed.cwd } : {}),
      })
      return emit(formatRun(run), run.summary.failed > 0 ? 1 : 0)
    }

    if (command === 'eval' && args[0] === 'compare') {
      const parsed = parseCompareArgs(args.slice(1))
      if (!parsed.base || !parsed.head) {
        throw new CliError('eval compare requires two run references')
      }
      const result = await compareCommand({
        base: parsed.base,
        head: parsed.head,
        ...(parsed.cwd ? { cwd: parsed.cwd } : {}),
      })
      return emit(formatCompare(result), result.summary.regressions.length ? 1 : 0)
    }

    if (command === 'evolve' && args[0] === 'run') {
      const parsed = parseEvolveRunArgs(args.slice(1))
      if (!parsed.tasksFile) throw new CliError('evolve run requires a tasks file')
      const result = await runEvolveCommand({
        tasksFile: parsed.tasksFile,
        ...(parsed.cwd ? { cwd: parsed.cwd } : {}),
        ...(parsed.outputDir ? { outputDir: parsed.outputDir } : {}),
        ...(parsed.maxIterations !== undefined
          ? { maxIterations: parsed.maxIterations }
          : {}),
        ...(parsed.maxRuns !== undefined ? { maxRuns: parsed.maxRuns } : {}),
        ...(parsed.baseSystem ? { baseSystem: parsed.baseSystem } : {}),
        ...(parsed.model ? { model: parsed.model } : {}),
        ...(parsed.baseUrl ? { baseUrl: parsed.baseUrl } : {}),
        ...(parsed.maxTokens !== undefined ? { maxTokens: parsed.maxTokens } : {}),
        ...(parsed.temperature !== undefined ? { temperature: parsed.temperature } : {}),
        ...(parsed.maxTurns !== undefined ? { maxTurns: parsed.maxTurns } : {}),
        ...(parsed.maxSteps !== undefined ? { maxSteps: parsed.maxSteps } : {}),
        ...(parsed.cache !== undefined ? { cache: parsed.cache } : {}),
        ...(parsed.timeoutMs !== undefined ? { timeoutMs: parsed.timeoutMs } : {}),
        ...(parsed.maxRetries !== undefined ? { maxRetries: parsed.maxRetries } : {}),
        ...(parsed.retryDelayMs !== undefined
          ? { retryDelayMs: parsed.retryDelayMs }
          : {}),
      })
      return emit(formatEvolveResult(result), 0)
    }

    throw new CliError(`unknown command: ${command ?? '<empty>'}`)
  })().catch((error: unknown) => {
    if (error instanceof CliError) return emit(`error: ${error.message}`, 2)
    return emit(`error: ${error instanceof Error ? error.message : String(error)}`, 2)
  })
}

interface ParsedRunArgs {
  tasksFile?: string
  candidateName?: string
  cache?: boolean
  outputFile?: string
  cwd?: string
}

interface ParsedCompareArgs {
  base?: string
  head?: string
  cwd?: string
}

interface ParsedRunAgentArgs {
  prompt?: string
  cwd?: string
  sessionFile?: string
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

interface ParsedEvolveRunArgs {
  tasksFile?: string
  cwd?: string
  outputDir?: string
  maxIterations?: number
  maxRuns?: number
  baseSystem?: string
  model?: string
  baseUrl?: string
  maxTokens?: number
  temperature?: number
  maxTurns?: number
  maxSteps?: number
  cache?: boolean
  timeoutMs?: number
  maxRetries?: number
  retryDelayMs?: number
}

function parseRunArgs(args: readonly string[]): ParsedRunArgs {
  const parsed: ParsedRunArgs = {}
  let cursor = 0
  while (cursor < args.length) {
    const arg = args[cursor]!
    if (arg === '--candidate' || arg === '--output' || arg === '--cwd') {
      const value = args[cursor + 1]
      if (!value) throw new CliError(`${arg} requires a value`)
      if (arg === '--candidate') parsed.candidateName = value
      if (arg === '--output') parsed.outputFile = value
      if (arg === '--cwd') parsed.cwd = value
      cursor += 2
    } else if (arg === '--no-cache') {
      parsed.cache = false
      cursor += 1
    } else if (!parsed.tasksFile) {
      parsed.tasksFile = arg
      cursor += 1
    } else {
      throw new CliError(`unexpected argument: ${arg}`)
    }
  }
  return parsed
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

function parseEvolveRunArgs(args: readonly string[]): ParsedEvolveRunArgs {
  const parsed: ParsedEvolveRunArgs = {}
  const positional: string[] = []
  let cursor = 0
  while (cursor < args.length) {
    const arg = args[cursor]!
    if (!arg.startsWith('--')) {
      positional.push(arg)
      cursor += 1
      continue
    }
    if (arg === '--no-cache') {
      parsed.cache = false
      cursor += 1
      continue
    }

    const eq = arg.indexOf('=')
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2)
    const value = eq >= 0 ? arg.slice(eq + 1) : args[cursor + 1]
    if (!value) throw new CliError(`--${name} requires a value`)
    assignEvolveRunOption(parsed, name, value)
    cursor += eq >= 0 ? 1 : 2
  }

  const tasksFile = positional.join(' ').trim()
  if (tasksFile) parsed.tasksFile = tasksFile
  return parsed
}

function assignEvolveRunOption(
  parsed: ParsedEvolveRunArgs,
  name: string,
  value: string,
): void {
  switch (name) {
    case 'cwd':
      parsed.cwd = value
      return
    case 'output-dir':
      parsed.outputDir = value
      return
    case 'iterations':
      parsed.maxIterations = parseFiniteNumber('--iterations', value)
      return
    case 'max-runs':
      parsed.maxRuns = parseFiniteNumber('--max-runs', value)
      return
    case 'base-system':
      parsed.baseSystem = value
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
    case 'no-cache':
      parsed.cache = false
      return
    default:
      throw new CliError(`unknown option: --${name}`)
  }
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

function parseCompareArgs(args: readonly string[]): ParsedCompareArgs {
  const parsed: ParsedCompareArgs = {}
  let cursor = 0
  while (cursor < args.length) {
    const arg = args[cursor]!
    if (arg === '--cwd') {
      const value = args[cursor + 1]
      if (!value) throw new CliError('--cwd requires a value')
      parsed.cwd = value
      cursor += 2
    } else if (!parsed.base) {
      parsed.base = arg
      cursor += 1
    } else if (!parsed.head) {
      parsed.head = arg
      cursor += 1
    } else {
      throw new CliError(`unexpected argument: ${arg}`)
    }
  }
  return parsed
}

function emit(output: string, code: number): number {
  process.stdout.write(`${output}\n`)
  return code
}

export const name = '@tnega/cli'
