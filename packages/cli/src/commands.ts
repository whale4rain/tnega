import { join, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Context, type Plugin } from '@tnega/core'
import {
  agent,
  defineAgent,
  type AgentContextBudget,
  type AgentDefinition,
  type AgentInbox,
  type AgentLoop,
  type AgentInput,
  type AgentRunOptions,
  type AgentRunResult,
  type LLMAdapter,
} from '@tnega/agent'
import { createLlmAdapter } from '@tnega/llm'
import { session, type SessionProjector } from '@tnega/session'
import {
  builtinTools,
  tools,
  type BuiltinToolsConfig,
  type ToolPolicy,
} from '@tnega/tools'
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
  importBigCodeBench,
  importHumanEval,
  importMbpp,
  importSweBench,
  type BenchmarkImportOptions,
  type ImportedBenchmark,
} from '@tnega/benchmark'
import {
  readSystemConfig,
  resolveLlmEnv,
  systemConfigPath,
} from './config.js'
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
  taskFilter?: string
  cache?: boolean
  budget?: RunBudget
  outputFile?: string
  cwd?: string
  model?: string
  baseUrl?: string
  maxTokens?: number
  temperature?: number
  maxTurns?: number
  maxSteps?: number
  timeoutMs?: number
  maxRetries?: number
  retryDelayMs?: number
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
  configFile?: string
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
  configFile?: string
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

export interface ImportBenchmarkCommandOptions {
  source: string
  outDir?: string
  subset?: number
  repo?: string
  ids?: string
  version?: string
  mirror?: string
  force?: boolean
}

export interface LlmEnvConfig {
  apiKey?: string
  baseUrl?: string
  model?: string
}

export { resolveLlmEnv } from './config.js'

export interface AgentRuntimeOptions {
  cwd: string
  sessionFile: string
  llm?: LLMAdapter
  inbox?: AgentInbox
  allowNetwork?: boolean
  allowShell?: boolean
  maxTurns?: number
  maxSteps?: number
  contextBudget?: AgentContextBudget
  agent?: AgentDefinition
  sessionProjector?: SessionProjector
  toolPolicy?: ToolPolicy
  builtinTools?: false | BuiltinToolsConfig
  plugins?: readonly Plugin[]
}

export interface AgentRuntime {
  root: Context
  dispose: () => Promise<void>
}

export class CliError extends Error {
  override name = 'CliError'
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function toTask(value: unknown, index: number, file: string): Task {
  const record = asRecord(value)
  const id = typeof record.id === 'string' ? record.id : `task-${index + 1}`
  const task: Task = {
    id,
  }
  const tasksDir = dirname(resolve(file))
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
  const fixture = record.fixture === undefined ? undefined : asRecord(record.fixture)
  if (fixture !== undefined) {
    const parsedFixture: NonNullable<Task['fixture']> = {}
    if (typeof fixture.root === 'string') {
      parsedFixture.root = resolve(tasksDir, fixture.root)
    }
    if (Array.isArray(fixture.files)) {
      parsedFixture.files = fixture.files.flatMap((entry): Array<{
        path: string
        content?: string
        from?: string
      }> => {
        const item = asRecord(entry)
        if (typeof item.path !== 'string') return []
        const fileEntry: { path: string; content?: string; from?: string } = {
          path: item.path,
        }
        if (typeof item.content === 'string') fileEntry.content = item.content
        if (typeof item.from === 'string') fileEntry.from = item.from
        return [fileEntry]
      })
    }
    task.fixture = parsedFixture
  }
  if (typeof record.setup === 'string') task.setup = record.setup
  if (typeof record.check === 'string') task.check = record.check
  if (typeof record.teardown === 'string') task.teardown = record.teardown
  if (typeof record.trials === 'number' && Number.isFinite(record.trials)) {
    task.trials = Math.max(1, Math.floor(record.trials))
  }
  const permissions = record.permissions === undefined ? undefined : asRecord(record.permissions)
  if (permissions !== undefined) {
    const parsedPermissions: Task['permissions'] = {}
    if (Array.isArray(permissions.tools)) {
      parsedPermissions.tools = permissions.tools
        .filter((entry): entry is string => typeof entry === 'string')
    }
    const shell = permissions.shell === undefined ? undefined : asRecord(permissions.shell)
    if (shell !== undefined) {
      const parsedShell: NonNullable<Task['permissions']>['shell'] = {
        enabled: shell.enabled === true,
      }
      if (Array.isArray(shell.allow)) {
        parsedShell.allow = shell.allow
          .filter((entry): entry is string => typeof entry === 'string')
      }
      if (Array.isArray(shell.deny)) {
        parsedShell.deny = shell.deny
          .filter((entry): entry is string => typeof entry === 'string')
      }
      parsedPermissions.shell = parsedShell
    }
    if (permissions.network !== undefined) parsedPermissions.network = permissions.network === true
    if (permissions.skills !== undefined) parsedPermissions.skills = permissions.skills === true
    if (permissions.mcp !== undefined) parsedPermissions.mcp = permissions.mcp === true
    task.permissions = parsedPermissions
  }
  if (record.split === 'train' || record.split === 'val') {
    task.split = record.split
  }
  return task
}

export function loadTasksFile(file: string): TasksFile {
  const text = readFileSync(resolve(file), 'utf8')
  const data = /^\s*\{/.test(text)
    ? JSON.parse(text) as Record<string, unknown>
    : parseYaml(text)
  const tasks = Array.isArray(data.tasks)
    ? data.tasks.map((entry, index) => toTask(entry, index, file))
    : []
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

interface CandidateFileEntry {
  preset: CandidatePreset
  coding?: {
    model?: string
    baseUrl?: string
    skills?: boolean
    planTools?: boolean
  }
}

function candidateFromFile(
  tasksFile: TasksFile,
  name: string | undefined,
): CandidateFileEntry {
  const candidates = tasksFile.candidates ?? {}
  const candidateName = name ?? tasksFile.defaultCandidate
  if (!candidateName || !(candidateName in candidates)) {
    return {
      preset: {
        plugin: (ctx: Context) => {
          ctx.provide('evalCandidateName', candidateName ?? 'default')
        },
        name: candidateName ?? 'default',
      },
    }
  }
  const entry = asRecord(candidates[candidateName])
  if (entry.loop === 'echo') {
    return {
      preset: {
        plugin: (ctx: Context) => {
          ctx.provide('evalCandidateName', candidateName)
          ctx.provide('agentLoop', echoLoop)
        },
        name: candidateName,
        ...(typeof entry.version === 'string' ? { version: entry.version } : {}),
      },
    }
  }
  if (entry.coding === true) {
    const coding: CandidateFileEntry['coding'] = {}
    if (typeof entry.model === 'string') coding.model = entry.model
    if (typeof entry.baseUrl === 'string') coding.baseUrl = entry.baseUrl
    if (entry.skills !== undefined) coding.skills = entry.skills === true
    if (entry.planTools !== undefined) coding.planTools = entry.planTools === true
    return {
      preset: {
        plugin: (ctx: Context) => {
          ctx.provide('evalCandidateName', candidateName)
        },
        name: candidateName,
        ...(typeof entry.version === 'string' ? { version: entry.version } : {}),
      },
      coding,
    }
  }
  if (entry.plugin === undefined) {
    return {
      preset: {
        plugin: (ctx: Context) => {
          ctx.provide('evalCandidateName', candidateName)
        },
        name: candidateName,
        ...(typeof entry.version === 'string' ? { version: entry.version } : {}),
      },
    }
  }
  return {
    preset: {
      plugin: entry.plugin as unknown as Plugin,
      name: candidateName,
      ...(typeof entry.version === 'string' ? { version: entry.version } : {}),
      ...(entry.config !== undefined ? { config: asRecord(entry.config) } : {}),
    },
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
  const tasks = options.taskFilter
    ? tasksFile.tasks.filter(task => task.id === options.taskFilter)
    : tasksFile.tasks
  if (options.taskFilter && !tasks.length) {
    throw new CliError(`task not found: ${options.taskFilter}`)
  }
  const outputDir = resolve(cwd, tasksFile.outputDir ?? '.tnega/runs')
  const candidate = candidateFromFile(tasksFile, options.candidateName)
  const root = await createEvalContext(cwd, {
    outputDir,
    defaultBudget: options.budget ?? {},
  })
  const runOptions: EvalRunOptions = {
    candidate: candidate.preset,
    tasks,
    cache: options.cache ?? true,
  }
  if (options.outputFile) runOptions.outputFile = resolve(cwd, options.outputFile)
  if (tasksFile.strategyNames) {
    runOptions.strategyNames = tasksFile.strategyNames
  }
  if (candidate.coding) {
    const systemConfig = await readSystemConfig()
    const envConfig = resolveLlmEnv(process.env)
    const apiKey = envConfig.apiKey ?? systemConfig.apiKey
    if (!apiKey) {
      throw new CliError(
        'missing LLM API key for coding eval; set OPENCODE_GO_API_KEY (or OPENAI_API_KEY / DEEPSEEK_API_KEY) or configure it in the tnega config file',
      )
    }
    const model = options.model
      ?? envConfig.model
      ?? systemConfig.model
      ?? candidate.coding.model
    const baseUrl = options.baseUrl
      ?? envConfig.baseUrl
      ?? systemConfig.baseUrl
      ?? candidate.coding.baseUrl
    const adapter = createLlmAdapter({
      apiKey,
      ...(model ? { model } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(systemConfig.temperature !== undefined
        && options.temperature === undefined
        ? { temperature: systemConfig.temperature }
        : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
      ...(options.retryDelayMs !== undefined
        ? { retryDelayMs: options.retryDelayMs }
        : {}),
    })
    runOptions.coding = {
      llm: adapter,
      agent: {
        ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
        ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
      },
      coding: {
        skills: candidate.coding.skills ?? true,
        planTools: candidate.coding.planTools ?? true,
        mcp: false,
      },
    }
    if (!runOptions.strategyNames) {
      runOptions.strategyNames = ['check', 'trace']
    }
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

export async function runAgentCommand(
  options: RunAgentCommandOptions,
): Promise<RunAgentCommandResult> {
  const cwd = options.cwd ?? process.cwd()
  const sessionFile = resolve(cwd, options.sessionFile ?? join('.tnega', 'run.jsonl'))
  const configFile = options.configFile ?? systemConfigPath()
  const systemConfig = await readSystemConfig(configFile)
  const envConfig = resolveLlmEnv(process.env)
  const apiKey = envConfig.apiKey ?? systemConfig.apiKey
  if (!apiKey) {
    throw new CliError(
      'missing LLM API key; set OPENCODE_GO_API_KEY (or OPENAI_API_KEY / DEEPSEEK_API_KEY) or configure it in the tnega config file',
    )
  }

  const model = options.model ?? envConfig.model ?? systemConfig.model
  const baseUrl = options.baseUrl
    ?? envConfig.baseUrl
    ?? systemConfig.baseUrl
  const adapter = createLlmAdapter({
    apiKey,
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(systemConfig.temperature !== undefined
      && options.temperature === undefined
      ? { temperature: systemConfig.temperature }
      : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    ...(options.retryDelayMs !== undefined
      ? { retryDelayMs: options.retryDelayMs }
      : {}),
  })
  const context = await createAgentRuntime({
    cwd,
    sessionFile,
    llm: adapter,
    ...(options.allowNetwork !== undefined
      ? { allowNetwork: options.allowNetwork }
      : {}),
    ...(options.allowShell !== undefined ? { allowShell: options.allowShell } : {}),
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
    ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
  })
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

export async function createAgentRuntime(
  options: AgentRuntimeOptions,
): Promise<AgentRuntime> {
  const root = new Context()
  const fibers: Array<{ dispose: () => Promise<void> }> = []
  const sessionFiber = await root.plugin(session, {
    file: options.sessionFile,
    ...(options.sessionProjector ? { projector: options.sessionProjector } : {}),
  })
  fibers.push(sessionFiber)
  const toolsFiber = await root.plugin(tools, options.toolPolicy ?? {})
  fibers.push(toolsFiber)
  if (options.builtinTools !== false) {
    const builtinConfig: BuiltinToolsConfig = { cwd: options.cwd }
    if (options.allowNetwork) builtinConfig.allowNetwork = true
    if (options.allowShell) builtinConfig.allowShell = true
    if (options.builtinTools && typeof options.builtinTools === 'object') {
      Object.assign(builtinConfig, options.builtinTools)
    }
    const builtinToolsFiber = await root.plugin(builtinTools, builtinConfig)
    fibers.push(builtinToolsFiber)
  }
  if (options.agent) {
    const definitionFiber = await root.plugin(defineAgent(options.agent), {
      ...(options.llm ? { llm: options.llm } : {}),
      ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
      ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
      ...(options.inbox ? { inbox: options.inbox } : {}),
      ...(options.contextBudget ? { contextBudget: options.contextBudget } : {}),
    })
    fibers.push(definitionFiber)
  } else {
    const agentConfig: {
      llm?: LLMAdapter
      maxTurns?: number
      maxSteps?: number
      inbox?: AgentInbox
      contextBudget?: AgentContextBudget
    } = {}
    if (options.llm) agentConfig.llm = options.llm
    if (options.maxTurns !== undefined) agentConfig.maxTurns = options.maxTurns
    if (options.maxSteps !== undefined) agentConfig.maxSteps = options.maxSteps
    if (options.inbox) agentConfig.inbox = options.inbox
    if (options.contextBudget) agentConfig.contextBudget = options.contextBudget
    const agentFiber = await root.plugin(agent, agentConfig)
    fibers.push(agentFiber)
  }
  for (const plugin of options.plugins ?? []) {
    const fiber = await root.plugin(plugin)
    fibers.push(fiber)
  }
  return {
    root,
    dispose: async () => {
      for (const fiber of [...fibers].reverse()) await fiber.dispose()
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
  const configFile = options.configFile ?? systemConfigPath()
  const systemConfig = await readSystemConfig(configFile)
  const envConfig = resolveLlmEnv(process.env)
  const apiKey = envConfig.apiKey ?? systemConfig.apiKey
  if (!apiKey) {
    throw new CliError(
      'missing LLM API key; set OPENCODE_GO_API_KEY (or OPENAI_API_KEY / DEEPSEEK_API_KEY) or configure it in the tnega config file',
    )
  }

  const model = options.model ?? envConfig.model ?? systemConfig.model
  const baseUrl = options.baseUrl
    ?? envConfig.baseUrl
    ?? systemConfig.baseUrl
  const adapter = createLlmAdapter({
    apiKey,
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(systemConfig.temperature !== undefined
      && options.temperature === undefined
      ? { temperature: systemConfig.temperature }
      : {}),
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

export async function importBenchmarkCommand(
  options: ImportBenchmarkCommandOptions,
): Promise<ImportedBenchmark> {
  const outDir = resolve(options.outDir ?? 'data/benchmarks')
  const common: BenchmarkImportOptions = {
    outDir,
    ...(options.subset !== undefined ? { subset: options.subset } : {}),
    ...(options.repo ? { repo: options.repo } : {}),
    ...(options.ids ? { ids: options.ids } : {}),
    ...(options.version ? { version: options.version } : {}),
    ...(options.mirror ? { mirror: options.mirror } : {}),
    ...(options.force !== undefined ? { force: options.force } : {}),
  }
  const previousTasks = await readTaskEntries(join(outDir, 'tasks.json'))
  if (options.source === 'bigcodebench') {
    const result = await importBigCodeBench(common)
    await mergeTasksFile(result.tasksFile, previousTasks, options.source)
    return result
  }
  if (options.source === 'humaneval') {
    const result = await importHumanEval(common)
    await mergeTasksFile(result.tasksFile, previousTasks, options.source)
    return result
  }
  if (options.source === 'mbpp') {
    const result = await importMbpp(common)
    await mergeTasksFile(result.tasksFile, previousTasks, options.source)
    return result
  }
  if (options.source === 'swebench') {
    const result = await importSweBench(common)
    await mergeTasksFile(result.tasksFile, previousTasks, options.source)
    return result
  }
  throw new CliError(`unknown benchmark source: ${options.source}`)
}

async function readTaskEntries(tasksFile: string): Promise<unknown[]> {
  const text = await readFile(tasksFile, 'utf8').catch(() => undefined)
  if (!text || !/^\s*\{/.test(text)) return []
  const data = JSON.parse(text) as Record<string, unknown>
  return Array.isArray(data.tasks) ? data.tasks : []
}

async function mergeTasksFile(
  tasksFile: string,
  previousTasks: readonly unknown[],
  source: string,
): Promise<void> {
  const incomingText = await readFile(tasksFile, 'utf8')
  const incoming = JSON.parse(incomingText) as Record<string, unknown>
  const incomingTasks = Array.isArray(incoming.tasks) ? incoming.tasks : []
  const byId = new Map<string, unknown>()
  const retained = previousTasks.filter(entry => {
    const task = asRecord(entry)
    const dataset = asRecord(task.artifacts).dataset
    return typeof dataset !== 'string' || dataset !== source
  })
  for (const entry of [...retained, ...incomingTasks]) {
    const task = asRecord(entry)
    if (typeof task.id === 'string') byId.set(task.id, entry)
  }
  const merged = {
    outputDir: incoming.outputDir,
    strategyNames: incoming.strategyNames,
    candidates: incoming.candidates,
    defaultCandidate: incoming.defaultCandidate,
    tasks: [...byId.values()],
  }
  await writeFile(tasksFile, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
}

export function formatBenchmarkImport(result: ImportedBenchmark): string {
  return [
    `imported ${result.manifest.source}@${result.manifest.version}`,
    `tasks ${result.manifest.total}`,
    `tasks file ${result.tasksFile}`,
    `manifest ${result.manifestFile}`,
  ].join('\n')
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
