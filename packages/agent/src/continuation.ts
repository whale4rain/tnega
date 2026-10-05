import type { Context } from '@tnega/core'
import type { AgentTurnStoppingEvent } from './types.js'
import type { AgentRegistry } from './live.js'

/** Author name of the nudge, so views can fold it away. */
export const CONTINUATION_NUDGE_NAME = 'plugin:continue'

export const CONTINUATION_NUDGE = 'You ended your turn without a tool call, but your last message says you were about to do more. If work remains, continue now with the next step; if the task is finished, give your final answer.'

const ACTIONS_EN = 'run|check|look|read|open|fix|update|try|test|verify|search|start|create|write|edit|implement|add|inspect|investigate|examine|review|install|build|modify|change|apply|make|find|explore|continue|proceed'
const ACTIONS_ZH = '运行|检查|查看|看看|读取|打开|修复|修改|更新|尝试|测试|验证|搜索|启动|创建|编写|实现|添加|安装|构建|执行|继续'

// The end of a message that announces work instead of reporting it:
// "Let me run the tests.", "Now I'll update the docs", "接下来我来修改配置。"
const ANNOUNCES_NEXT = new RegExp([
  String.raw`\b(?:let me|let's|i'll|i will|i'm going to|i am going to|now i'll|next,? i'll)\s+(?:now\s+|first\s+|also\s+|quickly\s+|then\s+)?(?:${ACTIONS_EN})\b[^.!?\n]{0,160}[.…]?\s*$`,
  String.raw`(?:让我|我来|我先|我将|接下来我?|下面我?|现在我?|然后我?)(?:来|先|再|去)?(?:${ACTIONS_ZH})[^。！？\n]{0,80}[。…]?\s*$`,
].join('|'), 'i')

/**
 * Whether a turn that ended without tool calls looks cut short: the model
 * answered nothing, hit its output limit, or closed on an announcement of
 * its next action ("Let me check the tests:") rather than a result.
 * A question to the user is a deliberate stop.
 */
export function looksUnfinished(content: string, finishReason: string): boolean {
  if (finishReason === 'length') return true
  if (finishReason !== 'stop') return false
  const text = content.trim()
  if (!text) return true
  if (/[?？]\s*$/.test(text)) return false
  if (/[:：]\s*$/.test(text)) return true
  const tail = text.slice(-240).split(/\n\s*\n/).at(-1) ?? ''
  return ANNOUNCES_NEXT.test(tail)
}

export interface ContinuationNudgeConfig {
  /** Nudges per turn before the agent is allowed to stop (default 2). */
  maxPerTurn?: number
}

/**
 * Models sometimes end a turn mid-task: they say "Let me run the tests:" and
 * stop without the tool call. When a live Agent's turn stops like that, steer
 * it once more within the same turn instead of handing an unfinished job
 * back to the user. Bounded per turn, so a model that keeps stopping still
 * ends.
 */
export const continuationNudge = {
  name: 'continuation-nudge',
  apply(ctx: Context, config: ContinuationNudgeConfig = {}): void {
    const max = config.maxPerTurn ?? 2
    const sent = new Map<string, number>()
    ctx.on('agent/turn-stopping', async (event: AgentTurnStoppingEvent) => {
      if (!event.agentId) return undefined
      const last = event.steps.at(-1)?.completion
      if (!last || last.toolCalls?.length) return undefined
      const reason = event.finishReason === 'length' ? 'length' : last.finishReason
      if (!looksUnfinished(last.content ?? '', reason)) return undefined
      const key = `${event.agentId}:${event.turn ?? event.index}`
      const count = sent.get(key) ?? 0
      if (count >= max) return undefined
      const registry: AgentRegistry | undefined = ctx.get('agents')
      const agent = registry?.get(event.agentId)
      if (!agent) return undefined
      sent.set(key, count + 1)
      // Forget old turns; a turn only needs its own count.
      for (const old of sent.keys()) {
        if (sent.size <= 256) break
        sent.delete(old)
      }
      await agent.steer({ messages: [{ role: 'user', name: CONTINUATION_NUDGE_NAME, content: CONTINUATION_NUDGE }] })
      return undefined
    })
  },
}
