import type { ModelMessage } from '@tnega/session'

/** Prompts that turn a conversation into the checkpoint summary compaction keeps. */
export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`

export const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`

const UPDATE_SUMMARIZATION_INSTRUCTIONS = `Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`

export const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

${UPDATE_SUMMARIZATION_INSTRUCTIONS}`

export function buildCompactionPrompt(
  messages: readonly ModelMessage[],
  previousSummary?: string,
): string {
  let prompt = `<conversation>\n${serializeMessages(messages)}\n</conversation>\n\n`
  if (previousSummary) {
    prompt += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`
    prompt += UPDATE_SUMMARIZATION_PROMPT
  } else {
    prompt += SUMMARIZATION_PROMPT
  }
  return prompt
}

export function serializeMessages(messages: readonly ModelMessage[]): string {
  const parts: string[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      if (message.content) parts.push(`[User]: ${message.content}`)
    } else if (message.role === 'assistant') {
      const toolCalls: string[] = []
      for (const call of message.tool_calls ?? []) {
        const args = call.arguments && typeof call.arguments === 'object'
          ? Object.entries(call.arguments as Record<string, unknown>)
              .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
              .join(', ')
          : JSON.stringify(call.arguments ?? {})
        toolCalls.push(`${call.name}(${args})`)
      }
      if (message.content) parts.push(`[Assistant]: ${message.content}`)
      if (toolCalls.length) parts.push(`[Assistant tool calls]: ${toolCalls.join('; ')}`)
    } else if (message.role === 'tool') {
      if (message.content) parts.push(`[Tool result]: ${truncateSummaryText(message.content, 2000)}`)
    } else if (message.role === 'system') {
      if (message.content) parts.push(`[System]: ${message.content}`)
    }
  }
  return parts.join('\n\n')
}

export function truncateSummaryText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} more characters truncated]`
}
