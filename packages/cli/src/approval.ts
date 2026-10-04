import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context, Fiber } from '@tnega/core'
import type { LLMAdapter } from '@tnega/agent'
import type { SessionLog, ModelMessage } from '@tnega/session'
import type { ToolRequest } from '@tnega/tools'
import { foldApprovalMode, type ApprovalDecision, type ApprovalMode } from '@tnega/approval-review'
import { LlmApprovalReviewer } from '@tnega/approval-llm'
import { JevApprovalReviewer } from '@tnega/approval-jev'
import { OpenAIApprovalReviewer } from '@tnega/approval-openai'
import { autoApproval, type AutoApprovalRequest } from '@tnega/auto-approval'
import { createLlmAdapter } from '@tnega/llm'
import { effectiveApiKey, effectiveLlmConfig, type SystemConfig } from './config.js'

export interface ApprovalComposition {
  config: SystemConfig
  workspace: string
  adapter: LLMAdapter
  model?: string
  session: (agentId: string | undefined) => SessionLog | undefined
  mode?: (agentId?: string) => ApprovalMode | Promise<ApprovalMode>
  evidenceMessages?: (messages: ModelMessage[], agentId?: string) => Promise<ModelMessage[]>
}

/** Provider selection belongs here, never in the Consumer. */
export async function mountApprovalReview(ctx: Context, options: ApprovalComposition): Promise<Fiber> {
  return await ctx.plugin({ name: 'approval-composition', apply: child => applyApprovalReview(child, options) })
}

async function applyApprovalReview(ctx: Context, options: ApprovalComposition): Promise<void> {
  const review = options.config.approvalReview ?? { provider: 'conversation' }
  const timeout = review.timeoutMs ? { timeoutMs: review.timeoutMs } : {}
  if (review.provider === 'jev' || review.provider === 'openai') {
    const apiKey = review.apiKeyEnv ? process.env[review.apiKeyEnv] ?? review.apiKey ?? ''
      : review.apiKey ?? process.env[review.provider === 'jev' ? 'TYPESAFE_API_KEY' : 'OPENAI_API_KEY'] ?? ''
    const config = { apiKey, ...timeout, ...(review.model ? { model: review.model } : {}), ...(review.baseUrl ? { baseUrl: review.baseUrl } : {}) }
    if (review.provider === 'jev') await ctx.plugin(JevApprovalReviewer, config)
    else await ctx.plugin(OpenAIApprovalReviewer, config)
  } else {
    await ctx.plugin(LlmApprovalReviewer, {
      ...timeout,
      ...(options.model ? { model: options.model } : {}),
      adapter: review.provider === 'conversation' ? options.adapter : () => {
        if (!review.modelId || !options.config.models?.some(model => model.id === review.modelId)) {
          throw new Error('Approval model route is not configured')
        }
        const effective = effectiveLlmConfig(options.config, process.env, review.modelId)
        const key = effectiveApiKey(options.config, process.env, review.modelId)
        if (!key) throw new Error('Approval model credential is not configured')
        return createLlmAdapter({ ...effective, apiKey: key })
      },
    })
  }
  await ctx.plugin(autoApproval, {
    workspace: options.workspace,
    ...timeout,
    session: options.session,
    ...(options.evidenceMessages ? { evidenceMessages: options.evidenceMessages } : {}),
    mode: options.mode ?? (async agentId => {
      const session = options.session(agentId)
      return (session ? foldApprovalMode(await session.read()) : undefined) ?? review.defaultMode ?? 'manual'
    }),
    constraints: async () => {
      try { return await readFile(join(options.workspace, 'AGENTS.md'), 'utf8') }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return ''
        throw error
      }
    },
  })
}

export async function reviewAutomaticApproval(ctx: Context, request: ToolRequest): Promise<ApprovalDecision | undefined> {
  const event: AutoApprovalRequest = { tool: request }
  await ctx.parallel('approval/review', event)
  return event.decision
}
