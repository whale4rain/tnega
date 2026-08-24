import type { LLMAdapter } from '@tnega/agent'
import { agent } from '@tnega/agent'
import type { Context, Plugin } from '@tnega/core'
import type {
  Candidate,
  CandidateMutation,
  ProposalContext,
  ProposeRule,
} from './types.js'

export interface LlmCandidateConfig {
  system?: string
  maxTurns?: number
  maxSteps?: number
}

export interface LlmCandidateOptions {
  name: string
  version?: string
  system?: string
  adapter: LLMAdapter
  maxTurns?: number
  maxSteps?: number
  model?: Record<string, unknown>
  mutation?: CandidateMutation
  rationale?: string
}

export interface LlmProposal {
  name: string
  system: string
  rationale: string
  mutationDescription: string
}

export interface LlmProposeRuleOptions {
  adapter: LLMAdapter
  maxTurns?: number
  maxSteps?: number
  model?: Record<string, unknown>
  ruleId?: string
  parse?: (content: string) => LlmProposal | Promise<LlmProposal>
}

export class LlmProposalError extends Error {
  override name = 'LlmProposalError'
}

export function withSystemPrompt(adapter: LLMAdapter, system: string): LLMAdapter {
  return {
    async complete(messages, tools, options) {
      const hasSystem = messages.some(message => message.role === 'system')
      const next = !system || hasSystem
        ? messages
        : [{ role: 'system' as const, content: system }, ...messages]
      return adapter.complete(next, tools, options)
    },
  }
}

export function llmCandidate(options: LlmCandidateOptions): Candidate {
  const config: LlmCandidateConfig = {}
  if (options.system !== undefined) config.system = options.system
  if (options.maxTurns !== undefined) config.maxTurns = options.maxTurns
  if (options.maxSteps !== undefined) config.maxSteps = options.maxSteps

  const plugin: Plugin = {
    name: options.name,
    apply: async (ctx: Context, rawConfig: unknown) => {
      const candidateConfig = readConfig(rawConfig)
      const fiber = await ctx.plugin(agent, {
        llm: withSystemPrompt(options.adapter, candidateConfig.system ?? ''),
        ...(candidateConfig.maxTurns !== undefined
          ? { maxTurns: candidateConfig.maxTurns }
          : {}),
        ...(candidateConfig.maxSteps !== undefined
          ? { maxSteps: candidateConfig.maxSteps }
          : {}),
      })
      return () => fiber.dispose()
    },
  }

  return {
    name: options.name,
    plugin,
    ...(options.version ? { version: options.version } : {}),
    config: config as Record<string, unknown>,
    ...(options.mutation ? { mutation: options.mutation } : {}),
    ...(options.rationale ? { rationale: options.rationale } : {}),
    ...(options.model ? { model: options.model } : {}),
  }
}

export function createLlmProposeRule(options: LlmProposeRuleOptions): ProposeRule {
  const parse = options.parse ?? parseLlmProposal
  return {
    id: options.ruleId ?? 'llm-propose',
    description: 'use an LLM to propose a system prompt mutation',
    async apply(context) {
      const completion = await options.adapter.complete(
        [{ role: 'user', content: buildProposalPrompt(context) }],
        [],
        {},
      )
      const content = completion.content
      if (!content) {
        throw new LlmProposalError('LLM proposal returned no content')
      }
      const proposal = await parse(content)
      return llmCandidate({
        name: proposal.name,
        system: proposal.system,
        adapter: options.adapter,
        ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
        ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
        ...(options.model ? { model: options.model } : {}),
        mutation: {
          type: 'system-prompt',
          description: proposal.mutationDescription,
          patch: { system: proposal.system },
        },
        rationale: proposal.rationale,
      })
    },
  }
}

export function parseLlmProposal(content: string): LlmProposal {
  const json = extractJson(content)
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    throw new LlmProposalError(`LLM proposal is not valid JSON: ${message(error)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LlmProposalError('LLM proposal must be a JSON object')
  }
  const record = parsed as Record<string, unknown>
  const name = record.name
  const system = record.system
  const rationale = record.rationale
  const mutationDescription = record.mutationDescription
  if (typeof name !== 'string' || !name.trim()) {
    throw new LlmProposalError('LLM proposal missing string field: name')
  }
  if (typeof system !== 'string' || !system.trim()) {
    throw new LlmProposalError('LLM proposal missing string field: system')
  }
  if (typeof rationale !== 'string' || !rationale.trim()) {
    throw new LlmProposalError('LLM proposal missing string field: rationale')
  }
  if (typeof mutationDescription !== 'string' || !mutationDescription.trim()) {
    throw new LlmProposalError('LLM proposal missing string field: mutationDescription')
  }
  return {
    name: name.trim(),
    system: system.trim(),
    rationale: rationale.trim(),
    mutationDescription: mutationDescription.trim(),
  }
}

function readConfig(value: unknown): LlmCandidateConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  const config: LlmCandidateConfig = {}
  if (typeof record.system === 'string') config.system = record.system
  if (typeof record.maxTurns === 'number') config.maxTurns = record.maxTurns
  if (typeof record.maxSteps === 'number') config.maxSteps = record.maxSteps
  return config
}

function buildProposalPrompt(context: ProposalContext): string {
  const diagnosis = context.diagnosis
  const lines: string[] = [
    '你是 tnega 的自进化引擎。根据一次评测的诊断结果，生成一个改进后的 Agent 系统提示词候选。',
    '只输出一个 JSON 对象，不要 Markdown 代码块，不要额外解释。JSON 字段：',
    '{"name":"候选名","system":"新的系统提示词","rationale":"修改理由","mutationDescription":"具体改动说明"}',
    '',
    `迭代：${context.iteration}`,
  ]
  if (context.baseline) {
    const run = context.baseline
    lines.push(
      `baseline: ${run.candidate.name} score=${run.summary.score.toFixed(3)} `
        + `passed=${run.summary.passed}/${run.summary.total}`,
    )
  }
  if (diagnosis.failingTasks.length) {
    lines.push('失败任务：')
    for (const taskId of diagnosis.failingTasks) {
      const modes = diagnosis.failureModes.filter(mode => mode.taskId === taskId)
      const reasons = modes.map(mode => {
        const reason = mode.reason ? `(${mode.reason})` : ''
        return `${mode.strategy}=${mode.status}${reason}`
      }).join(', ')
      lines.push(`- ${taskId}: ${reasons}`)
    }
  } else if (context.baseline) {
    lines.push('当前 baseline 全部通过，请保持正确行为，并尝试让输出更稳定。')
  }
  if (context.history.length) {
    lines.push('已有候选（避免重复）：')
    for (const node of context.history.slice(-5)) {
      lines.push(`- ${node.candidate.name}: ${node.candidate.rationale ?? ''}`)
    }
  }
  lines.push('约束：system 必须是简洁可执行的中文或英文系统提示词；不要包含 JSON 之外的输出。')
  return lines.join('\n')
}

function extractJson(content: string): string {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) return fenced[1]
  const start = content.indexOf('{')
  const end = content.lastIndexOf('}')
  if (start < 0 || end < start) {
    throw new LlmProposalError('LLM proposal did not contain a JSON object')
  }
  return content.slice(start, end + 1)
}

function message(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
