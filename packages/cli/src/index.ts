import type { CompareResult, EvalRun } from '@tnega/eval'
import {
  CliError,
  compareCommand,
  formatCompare,
  formatRun,
  runCommand,
} from './commands.js'

export type { TasksFile } from './commands.js'
export {
  CliError,
  compareCommand,
  formatCompare,
  formatRun,
  loadTasksFile,
  runCommand,
} from './commands.js'
export { parseYaml } from './yaml.js'
export type { CompareResult, EvalRun }

export function main(argv: readonly string[]): Promise<number> {
  return (async () => {
    const [command, ...args] = argv
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
