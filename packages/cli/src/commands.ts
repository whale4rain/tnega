import { join, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { Context, type Plugin } from '@tnega/core'
import { agent, type AgentInput, type AgentRunResult } from '@tnega/agent'
import { session } from '@tnega/session'
import { tools } from '@tnega/tools'
import {
  evalPlugin,
  type CompareResult,
  type CandidatePreset,
  type EvalPluginConfig,
  type EvalRun,
  type EvalRunOptions,
  type EvalService,
  type RunBudget,
  type Task,
} from '@tnega/eval'
import { parseYaml } from './yaml.js'

export interface TasksFile {
  tasks: Task[]
  candidates?: Record<string, unknown>
  defaultCandidate?: string
  strategyNames?: string[]
  outputDir?: string
}

export interface RunCommandOptions {
  tasksFile: string
  candidateName?: string
  cache?: boolean
  budget?: RunBudget
  outputFile?: string
  cwd?: string
}

export interface CompareCommandOptions {
  base: string
  head: string
  outputDir?: string
  cwd?: string
}

export class CliError extends Error {
  override name = 'CliError'
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function toTask(value: unknown, index: number): Task {
  const record = asRecord(value)
  const id = typeof record.id === 'string' ? record.id : `task-${index + 1}`
  const task: Task = {
    id,
  }
  if (typeof record.name === 'string') task.name = record.name
  if (typeof record.description === 'string') task.description = record.description
  if (typeof record.inputText === 'string') {
    task.inputText = record.inputText
  } else if (typeof record.input === 'string') {
    task.inputText = record.input
  } else if (record.input !== undefined) {
    task.input = record.input
  }
  const assertion = record.assertion === undefined ? undefined : asRecord(record.assertion) as Task['assertion']
  if (assertion !== undefined) task.assertion = assertion
  if (Array.isArray(record.strategies)) {
    task.strategies = record.strategies.map(item => String(item))
  }
  const budget = record.budget === undefined ? undefined : asRecord(record.budget) as Task['budget']
  if (budget !== undefined) task.budget = budget
  const artifacts = record.artifacts === undefined ? undefined : asRecord(record.artifacts)
  if (artifacts !== undefined) task.artifacts = artifacts
  return task
}

export function loadTasksFile(file: string): TasksFile {
  const text = readFileSync(resolve(file), 'utf8')
  const data = parseYaml(text)
  const tasks = Array.isArray(data.tasks) ? data.tasks.map(toTask) : []
  const result: TasksFile = { tasks }
  if (data.candidates !== undefined) {
    result.candidates = asRecord(data.candidates)
  }
  if (typeof data.defaultCandidate === 'string') result.defaultCandidate = data.defaultCandidate
  if (Array.isArray(data.strategyNames)) {
    result.strategyNames = data.strategyNames.map(item => String(item))
  }
  if (typeof data.outputDir === 'string') result.outputDir = data.outputDir
  if (!tasks.length) {
    throw new CliError(`no tasks found in ${file}`)
  }
  return result
}

function candidateFromFile(
  tasksFile: TasksFile,
  name: string | undefined,
): CandidatePreset {
  const candidates = tasksFile.candidates ?? {}
  const candidateName = name ?? tasksFile.defaultCandidate
  if (!candidateName || !(candidateName in candidates)) {
    return {
      plugin: (ctx: Context) => {
        ctx.provide('evalCandidateName', candidateName ?? 'default')
      },
      name: candidateName ?? 'default',
    }
  }
  const entry = asRecord(candidates[candidateName])
  if (entry.loop === 'echo') {
    return {
      plugin: (ctx: Context) => {
        ctx.provide('evalCandidateName', candidateName)
        ctx.provide('agentLoop', echoLoop)
      },
      name: candidateName,
      ...(typeof entry.version === 'string' ? { version: entry.version } : {}),
    }
  }
  if (entry.plugin === undefined) {
    return {
      plugin: (ctx: Context) => {
        ctx.provide('evalCandidateName', candidateName)
      },
      name: candidateName,
      ...(typeof entry.version === 'string' ? { version: entry.version } : {}),
    }
  }
  return {
    plugin: entry.plugin as unknown as Plugin,
    name: candidateName,
    ...(typeof entry.version === 'string' ? { version: entry.version } : {}),
    ...(entry.config !== undefined ? { config: asRecord(entry.config) } : {}),
  }
}

function echoLoop(input?: AgentInput): Promise<AgentRunResult> {
  const text = input?.text ?? ''
  return Promise.resolve({
    input: input ?? {},
    output: text,
    finishReason: 'stop',
    steps: [],
    messages: text ? [{ role: 'user', content: text }] : [],
  })
}

async function createEvalContext(cwd: string, config: EvalPluginConfig = {}): Promise<Context> {
  const root = new Context()
  await root.plugin(session, { file: join(cwd, '.tnega', 'cli-session.jsonl') })
  await root.plugin(tools)
  await root.plugin(agent)
  await root.plugin(evalPlugin, config)
  return root
}

function evalService(root: Context): EvalService {
  return root.get('eval') as EvalService
}

export async function runCommand(options: RunCommandOptions): Promise<EvalRun> {
  const cwd = options.cwd ?? process.cwd()
  const tasksFile = loadTasksFile(options.tasksFile)
  const outputDir = resolve(cwd, tasksFile.outputDir ?? '.tnega/runs')
  const root = await createEvalContext(cwd, {
    outputDir,
    defaultBudget: options.budget ?? {},
  })
  const candidate = candidateFromFile(tasksFile, options.candidateName)
  const runOptions: EvalRunOptions = {
    candidate: candidate as CandidatePreset,
    tasks: tasksFile.tasks,
    cache: options.cache ?? true,
  }
  if (options.outputFile) runOptions.outputFile = resolve(cwd, options.outputFile)
  if (tasksFile.strategyNames) {
    runOptions.strategyNames = tasksFile.strategyNames
  }
  return evalService(root).run(runOptions)
}

export function formatRun(run: EvalRun): string {
  const lines: string[] = [
    `run ${run.id}`,
    `candidate ${run.candidate.name}${run.candidate.version ? `@${run.candidate.version}` : ''}`,
    `score ${run.summary.score.toFixed(3)} (${run.summary.passed} passed, ${run.summary.failed} failed, ${run.summary.skipped} skipped, ${run.summary.errors} errors)`,
  ]
  if (run.aborted) lines.push(`aborted: ${run.abortedReason ?? 'unknown'}`)
  if (run.cacheHits) lines.push(`cache hits: ${run.cacheHits}`)
  return lines.join('\n')
}

export function formatCompare(result: CompareResult): string {
  const lines: string[] = [
    `base ${result.base.id}: ${result.summary.baseScore.toFixed(3)}`,
    `head ${result.head.id}: ${result.summary.headScore.toFixed(3)}`,
    `delta ${result.summary.delta >= 0 ? '+' : ''}${result.summary.delta.toFixed(3)}`,
    ...result.summary.regressions.map(taskId => `regression ${taskId}`),
    ...result.summary.improvements.map(taskId => `improvement ${taskId}`),
  ]
  return lines.join('\n')
}

export async function compareCommand(options: CompareCommandOptions): Promise<CompareResult> {
  const cwd = options.cwd ?? process.cwd()
  const root = await createEvalContext(cwd, {
    outputDir: resolve(cwd, options.outputDir ?? '.tnega/runs'),
  })
  return evalService(root).compare(
    resolveRunInput(options.base, cwd),
    resolveRunInput(options.head, cwd),
  )
}

function resolveRunInput(input: string, cwd: string): string {
  if (input.endsWith('.json')) return resolve(cwd, input)
  return input
}
