import type { ModelMessage } from '@tnega/session'
import type { LLMAdapter } from '@tnega/agent'
import type { Plan, PlanItem, PlanStatus } from './types.js'

export class PlanGenerationError extends Error {
  override name = 'PlanGenerationError'
}

export const PLAN_GENERATION_PROMPT = `You are a planning assistant for a coding agent.
Analyze the user request and produce a concise, ordered implementation plan.

Respond with ONLY a JSON object in this exact shape:
{
  "summary": "one or two sentence overview of the goal",
  "items": [
    {
      "title": "short actionable step",
      "detail": "optional one-line detail, can be omitted"
    }
  ]
}

Rules:
- Split the work into 2-8 concrete steps with clear checkable outcomes.
- Keep titles short and imperative.
- Do not include markdown fences, prose, or anything outside the JSON object.`

export function parsePlanResponse(raw: string): Plan {
  const text = raw.trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (!match) throw new PlanGenerationError('plan response was not valid JSON')
    try {
      parsed = JSON.parse(match[1]!) as unknown
    } catch {
      throw new PlanGenerationError('plan response was not valid JSON')
    }
  }
  const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {}
  if (!Array.isArray(record.items) || !record.items.length) {
    throw new PlanGenerationError('plan response must include a non-empty items array')
  }
  const items: PlanItem[] = []
  for (let index = 0; index < record.items.length; index += 1) {
    const entry = record.items[index]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new PlanGenerationError(`plan item ${index} must be an object`)
    }
    const item = entry as Record<string, unknown>
    const title = typeof item.title === 'string' && item.title.trim()
      ? item.title.trim()
      : undefined
    if (!title) throw new PlanGenerationError(`plan item ${index} requires a title`)
    const detail = typeof item.detail === 'string' && item.detail.trim()
      ? item.detail.trim()
      : undefined
    items.push({
      id: `plan-${index + 1}`,
      title,
      status: 'pending',
      ...(detail ? { detail } : {}),
    })
  }
  const summary = typeof record.summary === 'string' && record.summary.trim()
    ? record.summary.trim()
    : undefined
  return {
    ...(summary ? { summary } : {}),
    items,
    status: 'pending',
  }
}

export function planToContext(plan: Plan): string {
  const lines = [
    '<plan>',
    ...(plan.summary ? [`Summary: ${plan.summary}`] : []),
    'Steps:',
    ...plan.items.map((item, index) => `${index + 1}. ${item.title}`),
    '</plan>',
  ]
  return lines.join('\n')
}

export function isValidPlanStatus(value: unknown): value is PlanStatus {
  return value === 'pending' || value === 'done' || value === 'failed'
}

export async function generatePlan(
  adapter: LLMAdapter,
  messages: readonly ModelMessage[],
  signal?: AbortSignal,
): Promise<Plan> {
  const completion = await adapter.complete(
    [
      { role: 'system', content: PLAN_GENERATION_PROMPT },
      ...messages,
    ],
    [],
    { maxSteps: 1, ...(signal ? { signal } : {}) },
  )
  if (completion.finishReason === 'error' || !completion.content) {
    throw new PlanGenerationError('plan generation returned no content')
  }
  return parsePlanResponse(completion.content)
}
