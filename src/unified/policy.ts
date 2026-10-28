import type {EvaluationSummary} from '../domain.js';

export const UNIFIED_SEARCH_POLICY = 'ditto-declarative-search-v1';
export const UNIFIED_STAGE_POLICY = 'paired-prefix-five-repeats-v1';
export const UNIFIED_DEFAULTS = Object.freeze({
  maxValidEvaluations: 20, maxDesignRounds: 100, maxProposalAttempts: 3,
  topK: 4, uniformWeight: .3, inverseTemperature: 20,
  validationRepeats: 5, testRepeats: 3, seed: 42, patience: 5,
});
export const REGRESSION_THRESHOLDS: Readonly<Record<number, number>> = Object.freeze({16:.15,32:.08,64:.05,128:.03});

/** Fixed prefixes, never chosen from scores. Small pinned datasets simply end earlier. */
export function unifiedStages(examples: number): readonly number[] {
  if (!Number.isSafeInteger(examples) || examples < 1) throw Error('Stage size must be a positive integer');
  return Object.freeze([...Object.keys(REGRESSION_THRESHOLDS).map(Number).filter(size => size < examples), examples]);
}

export interface StageDecision {
  readonly advance: boolean;
  readonly reason: 'engineering-failure'|'completed-full-evaluation'|'insufficient-paired-evidence'|'large-paired-regression'|'retain-for-larger-batch';
  readonly overlap: number;
  readonly pairedDelta: number|null;
  readonly threshold: number|null;
}

/** A cost-saving heuristic, not a significance test. Pair identical task AND repeat IDs. */
export function pairedRegressionDecision(
  evaluation: EvaluationSummary, reference: EvaluationSummary|undefined,
  stage: number, fullExamples: number,
): StageDecision {
  const base = {overlap:0,pairedDelta:null,threshold:REGRESSION_THRESHOLDS[stage]??null};
  if (evaluation.valid !== true || evaluation.results.some(row => row.valid !== true || row.error !== undefined || row.candidateFailure !== undefined)) {
    return {...base,advance:false,reason:'engineering-failure'};
  }
  if (stage === fullExamples) return {...base,advance:false,reason:'completed-full-evaluation'};
  const expected = stage * evaluation.repeats;
  const complete = reference?.valid === true && reference.examples === fullExamples && reference.repeats === evaluation.repeats;
  const prior = new Map((complete?reference.results:[]).filter(row => row.valid === true && row.error === undefined && row.candidateFailure === undefined).map(row => [row.caseId,row]));
  const rows = evaluation.results.filter(row => prior.has(row.caseId));
  if (evaluation.examples !== stage || evaluation.results.length !== expected || new Set(evaluation.results.map(row => row.caseId)).size !== expected
    || rows.length !== expected || !Number.isSafeInteger(evaluation.repeats) || evaluation.repeats < 1 || base.threshold === null) {
    return {...base,overlap:rows.length,advance:true,reason:'insufficient-paired-evidence'};
  }
  const pairedDelta = rows.reduce((sum,row) => sum + row.score-prior.get(row.caseId)!.score,0)/rows.length;
  const advance = pairedDelta >= -base.threshold - 1e-12;
  return {...base,overlap:rows.length,pairedDelta,advance,reason:advance?'retain-for-larger-batch':'large-paired-regression'};
}

/** Unknown usage is never interpreted as a free candidate in a score tie. */
export function comparableTokens(evaluation: EvaluationSummary): number {
  return evaluation.tokenUsageStatus === 'known-lower-bound' || (evaluation.unknownUsageRuns??0)>0
    || !Number.isFinite(evaluation.totalTokens) || evaluation.totalTokens < 0 ? Number.POSITIVE_INFINITY : evaluation.totalTokens;
}
