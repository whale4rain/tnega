import {
  agent,
  continuationNudge,
  DurableInbox,
  defineAgent,
  type AgentContextBudget,
  type AgentInbox,
  type AgentInput,
  type SystemPromptService,
  type LLMAdapter,
} from '@tnega/agent'
import { autoContextBudget } from '@tnega/compaction'
import { Context } from '@tnega/core'
import { GENERAL_SYSTEM_PROMPT } from '@tnega/persona'
import { isModelAttachment, session } from '@tnega/session'
import type { BuiltinToolsConfig } from '@tnega/tools'
import { basename } from 'node:path'
import { ptcCapability, runtimeCapabilities } from './compose.js'
import type { AgentRuntime, AgentRuntimeOptions } from './types.js'

/**
 * The id this scope's Agent answers to. Everything keyed by agent — the loop
 * guard's turn state, the continuation nudge's per-turn budget, a tool call's
 * attribution — reads it from events, so a run without one silently skips all
 * of them. The session file's name is stable across resumes of the same run.
 */
export function agentIdFor(options: AgentRuntimeOptions): string {
  if (options.agentId) return options.agentId
  const base = basename(options.sessionFile)
  return base.replace(/\.[^.]*$/, '') || base
}

/**
 * Automatic compaction for a long session. Without it a run past the model
 * window fails at the provider; with it the session keeps its newest tokens and
 * summarizes the rest, as the resident Web runtime already does.
 */
function contextBudgetFor(
  options: AgentRuntimeOptions,
): AgentRuntimeOptions['contextBudget'] {
  if (options.contextBudget) return options.contextBudget
  const llm = options.llm
  if (!llm || options.autoCompact === false) return undefined
  return autoContextBudget({
    llm: () => llm,
    ...(options.contextWindow !== undefined ? { contextWindow: options.contextWindow } : {}),
  })
}

export async function createAgentRuntime(
  options: AgentRuntimeOptions,
): Promise<AgentRuntime> {
  const merged: AgentRuntimeOptions = {
    ...(options.profile?.options ?? {}),
    ...options,
    plugins: [...(options.profile?.bundles ?? []), ...(options.plugins ?? [])],
  }
  const root = new Context()
  await root.plugin(session, {
    file: merged.sessionFile,
  })
  const durableInbox = merged.durableInbox ? await DurableInbox.restore(root.get('session')) : undefined
  const agentId = agentIdFor(merged)
  const contextBudget = contextBudgetFor(merged)

  // One capability slice for every composition: sandbox + builtin tools,
  // search, spill, office, skills, memory, jobs and PTC come from the bundle.
  const builtinOn = merged.builtinTools !== false
  const builtinConfig: BuiltinToolsConfig | false = builtinOn
    ? {
      ...(merged.allowNetwork ? { allowNetwork: true } : {}),
      ...(merged.allowShell ? { allowShell: true } : {}),
      ...(merged.builtinTools && typeof merged.builtinTools === 'object' ? merged.builtinTools : {}),
    }
    : false
  try {
    await root.plugin(runtimeCapabilities, {
      workspace: merged.cwd,
      permission: merged.sandboxMode ?? (merged.allowShell ? 'workspace-write' : 'read-only'),
      sessionId: merged.sessionFile,
      tools: merged.toolPolicy ?? {},
      builtin: builtinConfig,
      memory: true,
      summary: true,
      // A long turn is fine while it keeps moving; a turn that stalls is
      // nudged, then asked to reflect, then parked.
      loopGuard: merged.loopGuard ?? true,
      jobs: (merged.jobs ?? builtinOn)
        ? { resolveSession: () => root.get('session', false) }
        : false,
      ptc: false,
    })
    if (merged.agent) {
      await root.plugin(defineAgent(merged.agent), {
        agentId,
        ...(merged.llm ? { llm: merged.llm } : {}),
        ...(merged.contextWindow !== undefined ? { contextWindow: merged.contextWindow } : {}),
        ...(merged.maxTurns !== undefined ? { maxTurns: merged.maxTurns } : {}),
        ...(merged.maxSteps !== undefined ? { maxSteps: merged.maxSteps } : {}),
        ...(merged.inbox ? { inbox: merged.inbox } : {}),
        ...(contextBudget ? { contextBudget } : {}),
      })
    } else {
      const agentConfig: {
        agentId?: string
        llm?: LLMAdapter
        contextWindow?: number
        maxTurns?: number
        maxSteps?: number
        inbox?: AgentInbox
        contextBudget?: AgentContextBudget
        claimNextStep?: () => Promise<readonly AgentInput[]>
      } = {}
      agentConfig.agentId = agentId
      if (merged.llm) agentConfig.llm = merged.llm
      if (merged.contextWindow !== undefined) agentConfig.contextWindow = merged.contextWindow
      if (merged.maxTurns !== undefined) agentConfig.maxTurns = merged.maxTurns
      if (merged.maxSteps !== undefined) agentConfig.maxSteps = merged.maxSteps
      if (merged.inbox) agentConfig.inbox = merged.inbox
      if (contextBudget) agentConfig.contextBudget = contextBudget
      if (durableInbox) agentConfig.claimNextStep = async () => (await durableInbox.claimNextStep()).map(message => {
        const content: unknown = message.content
        if (Array.isArray(content)) {
          const messages = content.flatMap((entry: unknown) => {
            if (!entry || typeof entry !== 'object' || !('role' in entry) || entry.role !== 'user'
              || !('content' in entry) || typeof entry.content !== 'string') return []
            const attachments = 'attachments' in entry && Array.isArray(entry.attachments)
              ? entry.attachments.filter(isModelAttachment) : []
            return [{ role: 'user' as const, content: entry.content, ...(attachments.length ? { attachments } : {}) }]
          })
          if (messages.length) return { messages }
        }
        return { text: message.text ?? '' }
      })
      await root.plugin(agent, agentConfig)
    }
    // A turn that stops on "let me run the tests:" is steered back to work
    // instead of handing an unfinished job back to whoever started the run.
    if (merged.continuation !== false) await root.plugin(continuationNudge)
    for (const plugin of merged.plugins ?? []) await root.plugin(plugin)
    if (!merged.agent && builtinOn && !root.get('agentDefinition')) {
      const prompts: SystemPromptService = root.get('systemPrompt')
      root.effect(() => prompts.registerSection({ name: 'default:persona', order: 0, content: GENERAL_SYSTEM_PROMPT }))
    }
    // PTC mounts last: a profile plugin mounted above must still be unwound when
    // the PTC runtime fails to start.
    await root.plugin(ptcCapability, {
      mode: merged.ptc?.mode ?? 'native',
      runtime: {
        ...merged.ptcRuntime,
        ...(merged.ptc?.timeoutMs !== undefined ? { timeoutMs: merged.ptc.timeoutMs } : {}),
        ...(merged.ptc?.memoryLimitBytes !== undefined
          ? { memoryLimitBytes: merged.ptc.memoryLimitBytes }
          : {}),
      },
      resolveSession: () => root.get('session', false),
    })
  } catch (error) {
    await root.fiber.dispose()
    throw error
  }
  return {
    root,
    ...(durableInbox ? { inbox: durableInbox } : {}),
    // More plugins may mount after construction (for example Web answerers).
    dispose: async () => {
      await root.fiber.dispose()
    },
  }
}
