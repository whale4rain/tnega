import type { Context } from '@tnega/core'
import type { ToolDefinition } from '@tnega/tools'
import { parseQuestionInput, secretAnswerNote, UserQuestionError, type QuestionResult } from '@tnega/user-questions'

export interface ToolQuestionConfig { agentId?: string }
export const QUESTION_TOOL_NAME = 'ask_user_question'

/** Tell the model how to use each secret it was given, next to the answers. */
function withSecretNotes(result: QuestionResult): QuestionResult | (QuestionResult & { secrets: string[] }) {
  if (result.status !== 'answered') return result
  const notes = result.answers.flatMap(answer => answer.secret ? [secretAnswerNote(answer.secret)] : [])
  return notes.length ? { ...result, secrets: notes } : result
}

/** Model-facing consumer; runtime composition supplies the UI answerer. */
export const toolQuestion = {
  name: 'tool-question',
  inject: ['tools', 'userQuestions'],
  apply(ctx: Context, config: ToolQuestionConfig = {}): void {
    const tools = ctx.tools
    const definition: ToolDefinition = {
      schema: {
        name: QUESTION_TOOL_NAME,
        description: 'Ask the user questions with choices and always allow a custom text answer. Use blocking (default) only when an answer is necessary before continuing: the call waits and returns the answers. Use nonblocking for optional guidance while continuing independent work: the call returns a pending request immediately, and the eventual answer arrives as a user steering message. A question may omit its prompt or options; optional:true allows the user to skip it. Do not assume an unanswered question has been approved. To get a secret (API key, token, password), set secret to the environment variable name it should become, e.g. GITHUB_TOKEN, with no options: the user types it into a hidden field, your shell commands get it as that variable, and you never see the value. Never ask for a secret as a normal question or ask the user to paste one into chat.',
        parameters: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['blocking', 'nonblocking'] },
            questions: {
              type: 'array', minItems: 1, maxItems: 12,
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', minLength: 1 },
                  question: { type: 'string' },
                  options: { type: 'array', maxItems: 20, items: { type: 'object', properties: { label: { type: 'string', minLength: 1 }, description: { type: 'string' } }, required: ['label'] } },
                  multiple: { type: 'boolean' },
                  optional: { type: 'boolean' },
                  secret: { type: 'string', description: 'Environment variable name for a secret answer, e.g. GITHUB_TOKEN. The value is hidden from you.' },
                },
                required: ['id'],
              },
            },
          },
          required: ['questions'],
        },
      },
      metadata: { executionMode: 'exclusive', readOnly: true, question: true },
      async execute(input, options) {
        const agentId = options.agentId ?? config.agentId
        if (!agentId) throw new UserQuestionError('Question tool requires an agent identity', 'QUESTION_CALLER_UNAVAILABLE')
        return withSecretNotes(await ctx.userQuestions.ask(parseQuestionInput(input), {
          agentId,
          ...(options.callId === undefined ? {} : { callId: options.callId }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }))
      },
    }
    tools.register(definition)
  },
}
