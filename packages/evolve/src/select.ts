import type { CompareResult, EvalRun } from '@tnega/eval'
import type {
  ExperimentNode,
  GateCheck,
  SelectionPolicy,
} from './types.js'

export async function evaluateGate(
  node: ExperimentNode,
  baseline: EvalRun | undefined,
  compare: CompareResult | undefined,
  policy: SelectionPolicy = {},
): Promise<GateCheck[]> {
  const checks: GateCheck[] = []
  const run = node.run

  checks.push({
    name: 'run-complete',
    ok: !run.aborted && !run.error,
    detail: run.aborted
      ? `run aborted: ${run.abortedReason ?? 'unknown'}`
      : run.error
        ? `run errored: ${run.error.message}`
        : 'run completed',
  })

  checks.push({
    name: 'no-errors',
    ok: run.summary.errors === 0,
    detail: `${run.summary.errors} error verdicts`,
  })

  if (policy.minScore !== undefined) {
    const ok = run.summary.score >= policy.minScore
    checks.push({
      name: 'min-score',
      ok,
      detail: `score ${run.summary.score.toFixed(3)} >= ${policy.minScore}`,
    })
  }

  for (const strategy of policy.requiredStrategies ?? []) {
    const verdicts = run.verdicts.filter(verdict => verdict.strategy === strategy)
    const ok = verdicts.length > 0 && verdicts.every(verdict => verdict.status === 'pass')
    checks.push({
      name: `required:${strategy}`,
      ok,
      detail: ok
        ? `strategy ${strategy} passed ${verdicts.length} verdicts`
        : `strategy ${strategy} has ${verdicts.length} verdicts`,
    })
  }

  for (const strategy of policy.safetyStrategies ?? []) {
    const verdicts = run.verdicts.filter(verdict => verdict.strategy === strategy)
    const ok = verdicts.length > 0 && verdicts.every(verdict => verdict.status === 'pass')
    checks.push({
      name: `safety:${strategy}`,
      ok,
      detail: ok
        ? `safety strategy ${strategy} passed`
        : `safety strategy ${strategy} failed`,
    })
  }

  for (const taskId of policy.safetyTasks ?? []) {
    const verdicts = run.verdicts.filter(verdict => verdict.taskId === taskId)
    const ok = verdicts.length > 0 && verdicts.every(verdict => verdict.status === 'pass')
    checks.push({
      name: `safety-task:${taskId}`,
      ok,
      detail: ok
        ? `safety task ${taskId} passed`
        : `safety task ${taskId} failed`,
    })
  }

  if (!baseline || !compare) return checks
  const changed = compare.taskResults.filter(item => item.changed)
  const regressions = compare.summary.regressions
  const maxDegradation = regressions.length
    ? Math.max(...compare.taskResults
      .filter(item => item.delta < 0)
      .map(item => -item.delta))
    : 0

  if (policy.maxDegradation !== undefined) {
    const ok = maxDegradation <= policy.maxDegradation
    checks.push({
      name: 'max-degradation',
      ok,
      detail: `max regression ${maxDegradation.toFixed(3)} <= ${policy.maxDegradation}`,
    })
  }

  if (policy.maxRegressions !== undefined) {
    const ok = regressions.length <= policy.maxRegressions
    checks.push({
      name: 'max-regressions',
      ok,
      detail: `${regressions.length} regressions <= ${policy.maxRegressions}`,
    })
  }

  if (policy.maxRegressionRatio !== undefined) {
    const ratio = compare.taskResults.length
      ? regressions.length / compare.taskResults.length
      : 0
    const ok = ratio <= policy.maxRegressionRatio
    checks.push({
      name: 'max-regression-ratio',
      ok,
      detail: `regression ratio ${ratio.toFixed(3)} <= ${policy.maxRegressionRatio}`,
    })
  }

  if (policy.minDelta !== undefined) {
    const ok = compare.summary.delta >= policy.minDelta
    checks.push({
      name: 'min-delta',
      ok,
      detail: `delta ${compare.summary.delta.toFixed(3)} >= ${policy.minDelta}`,
    })
  }

  if (policy.minPairs !== undefined) {
    const ok = changed.length >= policy.minPairs
    checks.push({
      name: 'min-pairs',
      ok,
      detail: `${changed.length} changed pairs >= ${policy.minPairs}`,
    })
  }

  if (policy.requireImprovement) {
    const ok = compare.summary.improvements.length > 0
    checks.push({
      name: 'require-improvement',
      ok,
      detail: ok
        ? `${compare.summary.improvements.length} improvements`
        : 'no improvements',
    })
  }

  if (policy.significance) {
    const ok = await policy.significance(compare, policy)
    checks.push({
      name: 'significance',
      ok,
      detail: ok ? 'significance rule passed' : 'significance rule failed',
    })
  }

  return checks
}
