import { USER_ADDRESS, agentAddress, type BoxService } from '@tnega/box'
import type { Context } from '@tnega/core'
import type { ThreadService } from '@tnega/thread'
import type { ToolsService } from '@tnega/tools'

function fields(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('tool input must be an object')
  }
  return input as Record<string, unknown>
}

/**
 * 面向用户的消息工具。
 *
 * 一轮执行结束时的回复由 Project Loop 从 Session 自动发布，不需要调用这个工具。它只用于
 * **执行途中**主动说话：长活里的进度、需要用户拍板的选择、已经看出来的风险。用户的回复
 * 会像其他消息一样回到你的 inbox。
 *
 * 发送者身份由 Agent 作用域绑定 —— 模型不能在这里伪造用户身份，也不能替别的 Thread 发言。
 */
export const toolBox = {
  name: 'tool-box',
  inject: ['box', 'threads', 'tools'],
  apply(ctx: Context): void {
    const box = ctx.get('box') as BoxService
    const threads = ctx.get('threads') as ThreadService
    const tools = ctx.get('tools') as ToolsService

    tools.register({
      schema: {
        name: 'send_project_message',
        description: 'Send a message to the user in the project conversation while you are still working. Your final answer for this turn is published automatically, so use this only for a progress note, a question you cannot proceed without, or a risk the user should see now.',
        parameters: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'What to tell the user. Plain text, no markup required.' },
          },
          required: ['message'],
        },
      },
      async execute(input, options) {
        const value = fields(input)
        if (typeof value.message !== 'string' || !value.message.trim()) {
          throw new TypeError('message must be a non-empty string')
        }
        const agentId = options.agentId
        if (!agentId) throw new Error('box tools require a live Agent identity')
        const thread = await threads.get(agentId)
        if (!thread) throw new Error('box tools require a project thread identity')
        await box.send({
          sender: agentAddress(agentId),
          recipients: [USER_ADDRESS],
          // 根 Thread 的发言落在主对话；子 Thread 的落在它自己的面板。
          placement: thread.parentId === undefined
            ? { kind: 'main' }
            : { kind: 'thread', threadId: agentId },
          kind: 'agent-reply',
          text: value.message,
        })
        return 'Message delivered to the user.'
      },
    })
  },
}
