import type { AgentContextBudget, LLMAdapter } from '@tnega/agent'
import type { ModelMessage } from '@tnega/session'
import { buildCompactionPrompt, serializeMessages, SUMMARIZATION_SYSTEM_PROMPT, truncateSummaryText } from './compaction-prompt.js'

/** How a compaction summary is marked in the model's context. */
export const SUMMARY_PREFIX = '[compressed conversation]\n'

const NEAR_END_SYSTEM_PROMPT = 'You check on an AI coding agent that is running out of context. Read the end of its conversation and decide whether it is about to give the user its final answer: its work is done or one or two small steps remain (a last check, the summary). Reply with exactly YES or NO.'

/**
 * Automatic compaction for long sessions. Past 75% of the window the agent
 * compacts, unless the run is about to finish (judged once per run by the
 * model itself from the end of the conversation), in which case it keeps
 * its full context up to 90%. Compaction keeps the newest 16% verbatim and
 * replaces the rest with a structured summary written by the same model.
 */
export function autoContextBudget(options: {
  /** The session's model, for the summary and the near-end check. */
  llm: () => LLMAdapter
  contextWindow?: number
}): AgentContextBudget {
  return {
    ...(options.contextWindow !== undefined ? { limit: options.contextWindow } : {}),
    summarize: async messages => {
      const { conversation, previousSummary } = splitSummary(messages)
      const completion = await options.llm().complete([
        { role: 'system', content: SUMMARIZATION_SYSTEM_PROMPT },
        { role: 'user', content: buildCompactionPrompt(conversation, previousSummary) },
      ], [], {})
      const summary = completion.content?.trim()
      if (!summary) throw new Error('compaction returned no summary')
      return [{ role: 'system', content: `${SUMMARY_PREFIX}${summary}` }]
    },
    nearEnd: async messages => {
      const { conversation } = splitSummary(messages)
      const recent = truncateSummaryText(serializeMessages(conversation.slice(-8)), 6_000)
      const completion = await options.llm().complete([
        { role: 'system', content: NEAR_END_SYSTEM_PROMPT },
        { role: 'user', content: `<conversation-end>\n${recent}\n</conversation-end>\n\nIs the agent about to give its final answer? YES or NO.` },
      ], [], {})
      return /^\W*yes\b/i.test(completion.content ?? '')
    },
  }
}

/**
 * The conversation to summarize, without the system prompt, and the summary
 * a previous compaction left (so the new one updates it instead of
 * summarizing a summary).
 */
export function splitSummary(messages: readonly ModelMessage[]): { conversation: ModelMessage[]; previousSummary?: string } {
  let previousSummary: string | undefined
  const conversation: ModelMessage[] = []
  messages.forEach((message, index) => {
    if (message.role === 'system' && message.content.startsWith(SUMMARY_PREFIX)) {
      previousSummary = message.content.slice(SUMMARY_PREFIX.length)
    } else if (!(index === 0 && message.role === 'system')) {
      conversation.push(message)
    }
  })
  return { conversation, ...(previousSummary ? { previousSummary } : {}) }
}
