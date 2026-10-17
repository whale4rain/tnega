import type { Context } from '@tnega/core'
import type { AgentTurnStoppingEvent } from './types.js'

/** Author name of the nudge, so views can fold it away. */
export const CONTINUATION_NUDGE_NAME = 'plugin:continue'

/** The model announced more work and stopped without doing it. */
export const CONTINUATION_NUDGE = 'You ended your turn without a tool call, but your last message says you were about to do more. If work remains, continue now with the next step; if the task is finished, give your final answer.'

/** The step budget ran out mid-work, usually right after a tool call. */
export const BUDGET_NUDGE = 'The step budget for this turn ran out while you were still working, so the results of your last tool call were never read. Finish in this final step: read them above, then report the result, what changed, and anything still left to do.'

const ACTIONS_EN = 'run|check|look|read|open|fix|update|try|test|verify|search|start|create|write|edit|implement|add|inspect|investigate|examine|review|install|build|modify|change|apply|make|find|explore|continue|proceed'
const ACTIONS_ZH = '运行|检查|查看|看看|读取|打开|修复|修改|更新|尝试|测试|验证|搜索|启动|创建|编写|实现|添加|安装|构建|执行|继续'

// The end of a message that announces work instead of reporting it:
// "Let me run the tests.", "Now I'll update the docs", "接下来我来修改配置。"
const ANNOUNCES_NEXT = new RegExp([
  String.raw`\b(?:let me|let's|i'll|i will|i'm going to|i am going to|now i'll|next,? i'll)\s+(?:now\s+|first\s+|also\s+|quickly\s+|then\s+)?(?:${ACTIONS_EN})\b[^.!?\n]{0,160}[.…]?\s*$`,
  String.raw`(?:让我|我来|我先|我将|接下来我?|下面我?|现在我?|然后我?)(?:来|先|再|去)?(?:${ACTIONS_ZH})[^。！？\n]{0,80}[。…]?\s*$`,
].join('|'), 'i')

/** A message that ends on a sentence, a bracket or a markdown closer is closed. */
const CLOSED = /[.!?。！？)\]}"'”’」』）】*_~`|]\s*$|\p{Extended_Pictographic}\s*$/u

// "so" stays out: it usually closes a claim ("…, so it is fine").
const CONNECTORS_EN = "now|next|then|first|let me|let's|i'll|i will|i'm going to|i am going to"
const CONNECTORS_ZH = '现在|接下来|然后|首先|接着|下面|继续|其次'

/**
 * The fragment stops on a connector after a boundary — ". Now", ", then",
 * "，接下来". A connector with a plain word before it ("all tests pass now")
 * closes a clause instead of opening one, so that stays a finished claim.
 */
const ENDS_ON_CONNECTOR = new RegExp([
  String.raw`(?:^|[.!?。！？\n,，、;；])\s*(?:${CONNECTORS_EN})\s*$`,
  String.raw`(?:${CONNECTORS_ZH})\s*$`,
].join('|'), 'i')

/** The fragment opens with a connector, so it announces work it never did. */
const OPENS_CLAUSE = new RegExp([
  String.raw`^\s*(?:${CONNECTORS_EN})(?=[\s:,，、;；-]|$)`,
  String.raw`^\s*(?:${CONNECTORS_ZH})`,
].join('|'), 'i')

/** The last completion of a turn that is stopping. */
export interface StoppingStep {
  content: string
  /** Reason that completion reported: 'stop', 'length', 'tool_calls', 'error'. */
  finishReason: string
  /** Tool calls the completion asked for; a run that stops on one was mid-work. */
  toolCalls?: number
}

/**
 * Whether a stopping turn looks cut short instead of finished: the model
 * answered nothing, hit its output limit or the step budget, ended on a tool
 * call whose results it never read, or trailed off mid-sentence ("Let me check
 * the tests:", "… and now") rather than reporting a result.
 * A question to the user is a deliberate stop, and so is a concluding tool.
 */
export function looksUnfinished(step: StoppingStep, turnFinishReason: string = step.finishReason): boolean {
  if (turnFinishReason === 'length' || step.finishReason === 'length') return true
  // Out of steps or out of turns: whatever the last message said, the run never
  // got to answer, and a tool call it made was never read.
  if (turnFinishReason === 'max_steps' || turnFinishReason === 'max_turns') return true
  if (turnFinishReason !== 'stop' || step.finishReason !== 'stop') return false
  // Calls the harness answered: ending there was the model's own choice.
  if (step.toolCalls) return false
  const text = step.content.trim()
  if (!text) return true
  if (/[?？]\s*$/.test(text)) return false
  if (/[:：]\s*$/.test(text)) return true
  const tail = text.slice(-240).split(/\n\s*\n/).at(-1) ?? ''
  if (ANNOUNCES_NEXT.test(tail)) return true
  // No closing punctuation anywhere: the model never finished its sentence. It
  // trails off on a connector ("… and now", "… checking the tests, then"), or the
  // fragment left over opens with one ("Now the second half").
  if (CLOSED.test(text)) return false
  if (ENDS_ON_CONNECTOR.test(text.slice(-160))) return true
  // The last clause, commas included: "…, now the tricky part".
  const fragment = text.slice(-240).split(/[.!?。！？,，;；]\s*|\n+/).at(-1) ?? ''
  return OPENS_CLAUSE.test(fragment)
}

export interface ContinuationNudgeConfig {
  /** Nudges per turn before the agent is allowed to stop (default 2). */
  maxPerTurn?: number
}

/**
 * Models sometimes end a turn mid-task: they say "Let me run the tests:" and
 * stop without the tool call, or the step budget runs out right after a tool
 * call whose result they never read. When a live Agent's turn stops like that,
 * steer it once more within the same turn instead of handing an unfinished job
 * back to the user. Bounded per turn, so a model that keeps stopping still
 * ends; the step budget grants one extra step to the nudge, no more.
 */
export const continuationNudge = {
  name: 'continuation-nudge',
  apply(ctx: Context, config: ContinuationNudgeConfig = {}): void {
    const max = config.maxPerTurn ?? 2
    const sent = new Map<string, number>()
    ctx.on('agent/turn-stopping', async (event: AgentTurnStoppingEvent) => {
      if (!event.agentId) return undefined
      const last = event.steps.at(-1)?.completion
      if (!last) return undefined
      // 'length' and 'max_steps' describe the turn, not the last message.
      const reason = event.finishReason === 'length' || event.finishReason === 'max_steps'
        ? event.finishReason
        : last.finishReason
      const step: StoppingStep = {
        content: last.content ?? '',
        finishReason: last.finishReason,
        toolCalls: last.toolCalls?.length ?? 0,
      }
      if (!looksUnfinished(step, reason)) return undefined
      const key = `${event.agentId}:${event.turn ?? event.index}`
      const count = sent.get(key) ?? 0
      if (count >= max) return undefined
      const registry = ctx.get('agents', false)
      const agent = registry?.get(event.agentId)
      if (!agent) return undefined
      sent.set(key, count + 1)
      // Forget old turns; a turn only needs its own count.
      for (const old of sent.keys()) {
        if (sent.size <= 256) break
        sent.delete(old)
      }
      const content = reason === 'max_steps' ? BUDGET_NUDGE : CONTINUATION_NUDGE
      await agent.steer({ messages: [{ role: 'user', name: CONTINUATION_NUDGE_NAME, content }] })
      return undefined
    })
  },
}
