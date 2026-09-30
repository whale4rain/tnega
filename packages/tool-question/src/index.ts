import type { Context } from '@tnega/core'
import type { ToolDefinition, ToolsService } from '@tnega/tools'
import { parseQuestionInput, UserQuestionError } from '@tnega/user-questions'

export interface ToolQuestionConfig { agentId?: string }
export const QUESTION_TOOL_NAME = 'ask_user_question'

/** Model-facing consumer; runtime composition supplies the UI answerer. */
export const toolQuestion = {
  name: 'tool-question',
  inject: ['tools', 'userQuestions'],
  apply(ctx: Context, config: ToolQuestionConfig = {}): void {
    const tools: ToolsService = ctx.get('tools')
    const definition: ToolDefinition = {
      schema: {
        name: QUESTION_TOOL_NAME,
        description: 'Ask the user questions with choices and always allow a custom text answer. Use blocking (default) only when an answer is necessary before continuing: the call waits and returns the answers. Use nonblocking for optional guidance while continuing independent work: the call returns a pending request immediately, and the eventual answer arrives as a user steering message. A question may omit its prompt or options; optional:true allows the user to skip it. Do not assume an unanswered question has been approved.',
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
        return ctx.userQuestions.ask(parseQuestionInput(input), {
          agentId,
          ...(options.callId === undefined ? {} : { callId: options.callId }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        })
      },
    }
    tools.register(definition)
  },
}
