import type { EvalRun } from '@tnega/eval'
import {
  type Candidate,
  type CandidateSnapshot,
  type Diagnosis,
  type ProposalContext,
  type ProposeRule,
  type StrategySummary,
} from './types.js'

export function emptyDiagnosis(): Diagnosis {
  return {
    score: 0,
    total: 0,
    passed: 0,
    failed: 0,
    errors: 0,
    aborted: false,
    failureModes: [],
    failingTasks: [],
    strategySummary: {},
  }
}

export function diagnose(run: EvalRun): Diagnosis {
  const failureModes = run.verdicts
    .filter(verdict => verdict.status !== 'pass')
    .map(verdict => ({
      taskId: verdict.taskId,
      strategy: verdict.strategy,
      status: verdict.status,
      score: verdict.score,
      ...(verdict.reason ? { reason: verdict.reason } : {}),
    }))
  const failingTasks = [...new Set(failureModes.map(mode => mode.taskId))]
  const strategySummary: Record<string, StrategySummary> = Object.create(null) as Record<string, StrategySummary>

  for (const verdict of run.verdicts) {
    const entry = strategySummary[verdict.strategy] ??= {
      total: 0,
      passed: 0,
      failed: 0,
      errors: 0,
    }
    entry.total += 1
    if (verdict.status === 'pass') entry.passed += 1
    else if (verdict.status === 'fail') entry.failed += 1
    else if (verdict.status === 'skip') entry.failed += 1
    else entry.errors += 1
  }

  return {
    score: run.summary.score,
    total: run.summary.total,
    passed: run.summary.passed,
    failed: run.summary.failed,
    errors: run.summary.errors,
    aborted: run.aborted,
    ...(run.abortedReason ? { abortedReason: run.abortedReason } : {}),
    failureModes,
    failingTasks,
    strategySummary,
  }
}

export function candidateKey(candidate: Candidate): string {
  return [
    candidate.name,
    candidate.version ?? '',
    candidate.mutation?.type ?? '',
  ].join('@')
}

export async function proposeCandidates(
  context: ProposalContext,
  rules: readonly ProposeRule[],
): Promise<Candidate[]> {
  const candidates: Candidate[] = []
  const seen = new Set<string>()

  for (const rule of rules) {
    const result = await rule.apply(context)
    if (result === undefined || result === null) continue
    const list = Array.isArray(result) ? result : [result]
    for (const candidate of list) {
      if (!candidate || typeof candidate.name !== 'string' || !candidate.name) {
        throw new TypeError(`rule ${rule.id} produced a candidate without a name`)
      }
      if (!candidate.plugin) {
        throw new TypeError(`candidate ${candidate.name} requires a plugin`)
      }
      const key = candidateKey(candidate)
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push(candidate)
    }
  }

  return candidates
}

export function proposalContext(
  baseline: EvalRun | undefined,
  history: readonly import('./types.js').ExperimentNode[],
  rules: readonly ProposeRule[],
  iteration = history.length,
  diagnosis = baseline ? diagnose(baseline) : emptyDiagnosis(),
): ProposalContext {
  return {
    ...(baseline ? { baseline } : {}),
    diagnosis,
    iteration,
    history,
    rules,
  }
}

export function toCandidateSnapshot(candidate: Candidate): CandidateSnapshot {
  return {
    name: candidate.name,
    ...(candidate.version ? { version: candidate.version } : {}),
    ...(candidate.config ? { config: candidate.config } : {}),
    ...(candidate.model ? { model: candidate.model } : {}),
    ...(candidate.mutation ? { mutation: candidate.mutation } : {}),
    ...(candidate.rationale ? { rationale: candidate.rationale } : {}),
  }
}

export function toCandidatePreset(candidate: Candidate): import('@tnega/eval').CandidatePreset {
  return {
    plugin: candidate.plugin,
    name: candidate.name,
    ...(candidate.version ? { version: candidate.version } : {}),
    ...(candidate.config ? { config: candidate.config } : {}),
    ...(candidate.model ? { model: candidate.model } : {}),
  }
}
