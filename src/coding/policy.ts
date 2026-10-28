/** Application search policy, distinct from the pinned MFlow benchmark contract. */
export const CODING_MUTATION_POLICY = Object.freeze({
  id: 'global-rewiring-v2',
  maxAddedNodes: 1,
  maxRemovedNodesWithoutAddition: 1,
  maxExistingContentChanges: 5,
  maxToolChanges: 1,
  minimumEdgeEdits: 12,
  edgeEditsPerNode: 4,
});

/** An added or removed directed edge is one edit; reversal is two edits. */
export function dependencyEditBudget(nodeCount: number): number {
  if (!Number.isSafeInteger(nodeCount) || nodeCount < 1) throw Error('Invalid node count for dependency edit budget');
  return Math.max(CODING_MUTATION_POLICY.minimumEdgeEdits, CODING_MUTATION_POLICY.edgeEditsPerNode * nodeCount);
}

/** Actual bounded settings of the diagnostic module executor, not MFlow defaults. */
export const CODING_EXECUTION_POLICY = Object.freeze({
  maxDeclaredNodes: 24,
  maxLoopIterations: 12,
  synchronousVmMs: 100,
  toolVmMs: 200,
  toolWallMs: 1000,
  maxToolOutputCharacters: 65536,
});
