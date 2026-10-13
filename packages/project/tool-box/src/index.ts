import { REACTIONS, USER_ADDRESS, agentAddress, type BoxService } from '@tnega/box'
import type { Context } from '@tnega/core'
import type { ThreadService } from '@tnega/thread'
import type { ToolsService } from '@tnega/tools'

/**
 * A bubble is a chat line, not a report. Longer text is refused so the Agent
 * moves the detail into an artifact or its final answer instead of filling
 * the room (and its own output budget) with it.
 */
export const PROJECT_MESSAGE_MAX_CHARS = 600

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
        description: 'Publish one chat bubble to the user in your project conversation while working. Send a short material update, a question, or a risk the user should see now, in at most a few sentences (600 characters); put longer material in publish_artifact. Each call creates a separate visible message; internal assistant narration stays in execution details. Your final answer is also published automatically, so do not repeat a message already sent.',
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
        if (value.message.trim().length > PROJECT_MESSAGE_MAX_CHARS) {
          throw new RangeError(`message is ${value.message.trim().length} characters; a chat bubble holds at most ${PROJECT_MESSAGE_MAX_CHARS}. Say the point in a few sentences and publish longer material with publish_artifact.`)
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

    tools.register({
      schema: {
        name: 'react_to_message',
        description: `React with one emoji to the user's latest message to you, the way a teammate would in chat: ${Object.keys(REACTIONS).join(' ')}. A reaction is shown under that message and notifies no one. Use it when a short acknowledgement is all the message needs (then end your turn without text), or alongside your answer for a real win. Use it occasionally, never for routine work.`,
        parameters: {
          type: 'object',
          properties: {
            emoji: { type: 'string', enum: Object.keys(REACTIONS), description: 'The reaction.' },
          },
          required: ['emoji'],
        },
      },
      async execute(input, options) {
        const value = fields(input)
        const agentId = options.agentId
        if (!agentId) throw new Error('box tools require a live Agent identity')
        // The target is what this Agent actually received: the newest user message in its own Session.
        const agent = await threads.activate(agentId)
        const received = new Set((await agent.session.read()).flatMap(event => event.type === 'user/message'
          && typeof event.payload.name === 'string' && event.payload.name.startsWith('box:') ? [event.payload.name.slice(4)] : []))
        const target = (await box.timeline()).findLast(envelope => (envelope.kind === 'user-message' || envelope.kind === 'user-thread') && received.has(envelope.messageId))
        if (!target) throw new Error('There is no message from the user to react to yet.')
        await box.react({ messageId: target.messageId, emoji: String(value.emoji ?? ''), by: agentAddress(agentId) })
        return `Reacted ${String(value.emoji)} to the user's message.`
      },
    })
  },
}
