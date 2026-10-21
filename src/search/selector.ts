import { assertValidEvaluation } from "../benchmark/evaluator.js";
import type { SearchTreeNode } from "../domain.js";
import type { SeededRandom } from "./random.js";

export const AFLOW_SELECTION_ALPHA = 0.2;
export const AFLOW_SELECTION_LAMBDA = 0.3;

/** Exact AFlow mixed-probability selection over complete evaluated workflows. */
export function selectParent(
  candidates: readonly SearchTreeNode[],
  topK: number,
  random: SeededRandom,
): SearchTreeNode {
  const {pool,probabilities}=parentDistribution(candidates,topK);
  const sample = random.next();
  let cumulative = 0;
  for (let index = 0; index < pool.length; index++) {
    cumulative += probabilities[index]!;
    if (sample <= cumulative) return pool[index]!;
  }
  return pool.at(-1)!;
}

export function parentDistribution(candidates:readonly SearchTreeNode[],topK:number) {
  if (!candidates.length) throw new Error("Cannot select from an empty search frontier");
  if (!Number.isSafeInteger(topK) || topK < 1) throw new Error("topK must be a positive integer");
  if (candidates.some((candidate) => !candidate.evaluation)) {
    throw new Error("AFlow parent selection accepts only complete evaluated workflows");
  }

  for (const candidate of candidates) assertValidEvaluation(candidate.evaluation!);
  // Array.sort is stable in supported Node versions, matching AFlow's score-only
  // ordering for ties before sampling from the highest-scoring unique rounds.
  const ranked = [...candidates].sort((left, right) => right.evaluation!.score - left.evaluation!.score);
  const pool = ranked.slice(0, Math.min(topK, ranked.length));
  const scores = pool.map((candidate) => candidate.evaluation!.score * 100);
  const maximum = Math.max(...scores);
  const weights = scores.map((score) => Math.exp(AFLOW_SELECTION_ALPHA * (score - maximum)));
  const total = weights.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || total <= 0) throw new Error("Invalid parent-selection weights");
  const probabilities = weights.map((weight) =>
    AFLOW_SELECTION_LAMBDA / pool.length + (1 - AFLOW_SELECTION_LAMBDA) * weight / total,
  );

  return {pool,probabilities};
}

export function compareSearchNodes(left: SearchTreeNode, right: SearchTreeNode): number {
  const leftEvaluated = left.statistics.visits > 0;
  const rightEvaluated = right.statistics.visits > 0;
  if (leftEvaluated !== rightEvaluated) return leftEvaluated ? -1 : 1;

  return searchValue(right) - searchValue(left)
    || left.statistics.failedRuns - right.statistics.failedRuns
    || average(left.statistics.totalTokens, left.statistics.visits)
      - average(right.statistics.totalTokens, right.statistics.visits)
    || average(left.statistics.totalLatencyMs, left.statistics.visits)
      - average(right.statistics.totalLatencyMs, right.statistics.visits)
    || left.depth - right.depth
    || left.id.localeCompare(right.id);
}

/** Direct leaf evaluations use this comparator when freezing the best path. */
export function compareRunnableLeaves(left: SearchTreeNode, right: SearchTreeNode): number {
  if (!left.evaluation || !right.evaluation) {
    if (left.evaluation) return -1;
    if (right.evaluation) return 1;
    return left.id.localeCompare(right.id);
  }
  return right.evaluation.score - left.evaluation.score
    // AFlow get_best_round resolves ties in favor of the earliest round.
    || left.id.localeCompare(right.id);
}

function searchValue(node: SearchTreeNode): number {
  if (!node.statistics.visits) return Number.POSITIVE_INFINITY;
  return node.statistics.bestScore * 0.7 + node.statistics.meanScore * 0.3;
}

function average(total: number, count: number): number {
  return count ? total / count : Number.POSITIVE_INFINITY;
}
