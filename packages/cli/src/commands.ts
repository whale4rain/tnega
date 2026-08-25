import { join, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { Context, type Plugin } from '@tnega/core'
import {
  agent,
  type AgentLoop,
  type AgentInput,
  type AgentRunOptions,
  type AgentRunResult,
  type LLMAdapter,
} from '@tnega/agent'
import { openaiCompatAdapter } from '@tnega/llm'
import { session } from '@tnega/session'
import { builtinTools, tools } from '@tnega/tools'
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
import {
  createLlmProposeRule,
  evolvePlugin,
  llmCandidate,
  type EvolvePluginConfig,
  type EvolveService,
  type EvolveStepResult,
  type SelectionPolicy,
} from '@tnega/evolve'

export interface TasksFile {
  tasks: Task[]
  candidates?: Record<string, unknown>
  defaultCandidate?: string
  strategyNames?: string[]
  outputDir?: string
  evolve?: EvolveFileConfig
}

export interface EvolveFileConfig {
  maxIterations?: number
  maxRuns?: number
  baseSystem?: string
  policy?: SelectionPolicy
  budget?: RunBudget
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

export interface RunAgentCommandOptions {
  prompt: string
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

export interface RunAgentCommandResult {
  run: AgentRunResult
  sessionFile: string
}

export interface RunEvolveCommandOptions {
  tasksFile: string
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
  budget?: RunBudget
  cache?: boolean
  policy?: SelectionPolicy
  timeoutMs?: number
  maxRetries?: number
  retryDelayMs?: number
}

export interface RunEvolveCommandResult {
  prime: EvolveStepResult
  result: EvolveStepResult
  logFile: string
  runDir: string
}

export interface LlmEnvConfig {
  apiKey?: string
  baseUrl?: string
  model?: string
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
  if (data.evolve !== undefined) {
    result.evolve = asRecord(data.evolve) as EvolveFileConfig
  }
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

export function resolveLlmEnv(env: NodeJS.ProcessEnv = process.env): LlmEnvConfig {
  const config: LlmEnvConfig = {}
  const apiKey = env.OPENCODE_GO_API_KEY || env.OPENAI_API_KEY || env.DEEPSEEK_API_KEY
  if (apiKey) config.apiKey = apiKey
  if (env.OPENCODE_GO_BASE_URL) config.baseUrl = env.OPENCODE_GO_BASE_URL
  if (env.OPENCODE_GO_MODEL) config.model = env.OPENCODE_GO_MODEL
  return config
}

export async function runAgentCommand(
  options: RunAgentCommandOptions,
): Promise<RunAgentCommandResult> {
  const cwd = options.cwd ?? process.cwd()
  const sessionFile = resolve(cwd, options.sessionFile ?? join('.tnega', 'run.jsonl'))
  const envConfig = resolveLlmEnv(process.env)
  const apiKey = envConfig.apiKey
  if (!apiKey) {
    throw new CliError(
      'missing OPENCODE_GO_API_KEY (or OPENAI_API_KEY / DEEPSEEK_API_KEY); set it before running tnega run',
    )
  }

  const model = options.model ?? envConfig.model
  const baseUrl = options.baseUrl ?? envConfig.baseUrl
  const adapter = openaiCompatAdapter({
    apiKey,
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    ...(options.retryDelayMs !== undefined
      ? { retryDelayMs: options.retryDelayMs }
      : {}),
  })
  const context = await createRunContext(sessionFile, adapter, options)
  try {
    const loop = context.root.get('agentLoop') as AgentLoop
    const runOptions: AgentRunOptions = {}
    if (options.maxTurns !== undefined) runOptions.maxTurns = options.maxTurns
    if (options.maxSteps !== undefined) runOptions.maxSteps = options.maxSteps
    const run = await loop({ text: options.prompt }, runOptions)
    return { run, sessionFile }
  } finally {
    await context.dispose()
  }
}

async function createRunContext(
  sessionFile: string,
  llm: LLMAdapter,
  options: RunAgentCommandOptions,
) {
  const root = new Context()
  const sessionFiber = await root.plugin(session, { file: sessionFile })
  const toolsFiber = await root.plugin(tools)
  const builtinToolsFiber = await root.plugin(builtinTools, {
    cwd: options.cwd ?? process.cwd(),
    ...(options.allowNetwork ? { allowNetwork: true } : {}),
    ...(options.allowShell ? { allowShell: true } : {}),
  })
  const agentConfig: {
    llm: LLMAdapter
    maxTurns?: number
    maxSteps?: number
  } = { llm }
  if (options.maxTurns !== undefined) agentConfig.maxTurns = options.maxTurns
  if (options.maxSteps !== undefined) agentConfig.maxSteps = options.maxSteps
  const agentFiber = await root.plugin(agent, agentConfig)
  return {
    root,
    dispose: async () => {
      for (const fiber of [agentFiber, builtinToolsFiber, toolsFiber, sessionFiber].reverse()) {
        await fiber.dispose()
      }
    },
  }
}

export function formatAgentRun(result: RunAgentCommandResult): string {
  const output = result.run.output.trim()
  const lines: string[] = []
  if (output) lines.push(output)
  lines.push(`finish ${result.run.finishReason}`)
  lines.push(`steps ${result.run.steps.length}`)
  lines.push(`session ${result.sessionFile}`)
  return lines.join('\n')
}

export async function runEvolveCommand(
  options: RunEvolveCommandOptions,
): Promise<RunEvolveCommandResult> {
  const cwd = options.cwd ?? process.cwd()
  const tasksFile = loadTasksFile(options.tasksFile)
  const envConfig = resolveLlmEnv(process.env)
  const apiKey = envConfig.apiKey
  if (!apiKey) {
    throw new CliError(
      'missing OPENCODE_GO_API_KEY (or OPENAI_API_KEY / DEEPSEEK_API_KEY); set it before running tnega evolve run',
    )
  }

  const model = options.model ?? envConfig.model
  const baseUrl = options.baseUrl ?? envConfig.baseUrl
  const adapter = openaiCompatAdapter({
    apiKey,
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    ...(options.retryDelayMs !== undefined
      ? { retryDelayMs: options.retryDelayMs }
      : {}),
  })
  const modelConfig = model || baseUrl
    ? {
        ...(model ? { model } : {}),
        ...(baseUrl ? { baseUrl } : {}),
      }
    : undefined
  const evolveFile = tasksFile.evolve ?? {}
  const outputDir = resolve(cwd, options.outputDir ?? tasksFile.outputDir ?? '.tnega/experiments')
  const runDir = join(outputDir, 'runs')
  const policy = options.policy ?? evolveFile.policy ?? {
    minScore: 0,
    maxDegradation: 0,
    minDelta: 0.001,
  }
  const maxIterations = options.maxIterations ?? evolveFile.maxIterations ?? 3
  const baseSystem = options.baseSystem ?? evolveFile.baseSystem ?? ''
  const rule = createLlmProposeRule({
    adapter,
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
    ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
    ...(modelConfig ? { model: modelConfig } : {}),
  })

  const root = new Context()
  const evalFiber = await root.plugin(evalPlugin, { outputDir: runDir })
  const evolveConfig: EvolvePluginConfig = {
    outputDir,
    tasks: tasksFile.tasks,
    policy,
    rules: [rule],
    cache: options.cache ?? false,
  }
  if (tasksFile.strategyNames) evolveConfig.strategyNames = tasksFile.strategyNames
  const budget = options.budget ?? evolveFile.budget
  if (budget) {
    evolveConfig.budget = budget
  }
  const evolveFiber = await root.plugin(evolvePlugin, evolveConfig)
  try {
    const evolve = root.get('evolve') as EvolveService
    const baseline = llmCandidate({
      name: 'baseline',
      system: baseSystem,
      adapter,
      ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
      ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
      ...(modelConfig ? { model: modelConfig } : {}),
    })
    const prime = await evolve.step({ candidate: baseline })
    const maxRuns = options.maxRuns ?? evolveFile.maxRuns
    const result = await evolve.evolve({
      maxIterations,
      ...(maxRuns !== undefined ? { maxRuns } : {}),
      run: { cache: options.cache ?? false },
    })
    return {
      prime,
      result,
      logFile: join(outputDir, 'log.json'),
      runDir,
    }
  } finally {
    await evolveFiber.dispose()
    await evalFiber.dispose()
  }
}

export function formatEvolveResult(result: RunEvolveCommandResult): string {
  const lines: string[] = []
  const primeNode = stepNode(result.prime)
  const finalNode = stepNode(result.result)
  if (primeNode) {
    lines.push(
      `baseline ${candidateLabel(primeNode.candidate)}: `
        + `score ${primeNode.run.summary.score.toFixed(3)} `
        + `(${primeNode.run.summary.passed}/${primeNode.run.summary.total})`,
    )
  }
  lines.push(`decision ${result.result.kind}`)
  if (finalNode) {
    lines.push(`candidate ${candidateLabel(finalNode.candidate)}: score ${finalNode.run.summary.score.toFixed(3)}`)
    lines.push(`status ${finalNode.status}`)
    if (finalNode.decision?.reason) lines.push(`reason ${finalNode.decision.reason}`)
    if (finalNode.decision?.delta !== undefined) {
      const delta = finalNode.decision.delta
      lines.push(`delta ${delta >= 0 ? '+' : ''}${delta.toFixed(3)}`)
    }
  } else if (result.result.kind === 'no-candidate') {
    lines.push(`reason ${result.result.reason}`)
  }
  lines.push(`log ${result.logFile}`)
  return lines.join('\n')
}

function stepNode(result: EvolveStepResult) {
  return result.kind === 'no-candidate' ? undefined : result.node
}

function candidateLabel(candidate: { name: string; version?: string }): string {
  return candidate.version ? `${candidate.name}@${candidate.version}` : candidate.name
}
