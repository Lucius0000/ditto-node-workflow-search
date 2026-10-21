import { createHash } from "node:crypto";
import {
  STRATEGIES,
  type AgentPlanSpec,
  type ContextLoadNodeSpec,
  type GraphTransition,
  type NodeProposal,
  type SearchNodeStatistics,
  type SearchTreeNode,
  type SampleNodeSpec,
  type StrategyName,
  type TrajectoryNodeSpec,
  type WorkflowNodeSpec,
} from "../domain.js";
import { GENERATION } from "../protocol.js";
import { EXPERIMENT_EXECUTION } from "../model-profile.js";
import { validateCheckerDependencies } from "./checker-policy.js";

const GRAPH_ORDER = ["prepare", "solve", "refine"] as const;
const NODE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const SEARCH_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const DELIBERATION_MODES = new Set(["select", "merge", "consensus", "debate"]);
const REFLECTION_MODES = new Set(["critique", "verify", "revise"]);

export const EMPTY_STATISTICS: SearchNodeStatistics = Object.freeze({
  visits: 0,
  scoreSum: 0,
  meanScore: 0,
  bestScore: Number.NEGATIVE_INFINITY,
  failedRuns: 0,
  totalTokens: 0,
  totalLatencyMs: 0,
});

export function createRootNode(): ContextLoadNodeSpec {
  return Object.freeze({
    id: "context-load",
    type: "CONTEXT.LOAD",
    graphId: "prepare",
    dependencies: [] as const,
    config: Object.freeze({ includeTaskMetadata: true }),
  });
}

export function createInitialTrajectoryNode(instruction = "Solve the task carefully, verify constraints, and follow the requested answer format."): TrajectoryNodeSpec {
  return Object.freeze({
    id: "trajectory-1",
    type: "INFER.REASONING.TRAJECTORY",
    graphId: "solve",
    dependencies: Object.freeze([]),
    config: Object.freeze({
      instruction,
      strategy: "cot",
      options: Object.freeze({ rounds: 1 }),
      generation: GENERATION,
      maxSteps: EXPERIMENT_EXECUTION.maxSteps,
    }),
  });
}

/** Match AFlow round_1.Custom: one model call on the raw problem. */
export function createInitialSampleNode(instruction = ""): SampleNodeSpec {
  return Object.freeze({
    id: "sample-1", type: "INFER.REASONING.SAMPLE", graphId: "solve",
    dependencies: Object.freeze([]),
    config: Object.freeze({ role: "solver", instruction, generation: GENERATION }),
  });
}
export function isRawBaseline(node: WorkflowNodeSpec): boolean {
  return node.id === "sample-1" && node.type === "INFER.REASONING.SAMPLE";
}

export function createSearchTreeNode(
  id: string,
  searchParentId: string | null,
  depth: number,
  node: WorkflowNodeSpec,
  path: readonly WorkflowNodeSpec[],
): SearchTreeNode {
  if (!SEARCH_ID.test(id)) throw new Error(`Invalid search node ID: ${id}`);
  if (!Number.isSafeInteger(depth) || depth < 0) throw new Error("Search depth must be a non-negative integer");
  validateNodePath(path);
  if (path.at(-1)?.id !== node.id) throw new Error("A search vertex must hold the final Node in its construction path");
  return Object.freeze({
    id,
    searchParentId,
    depth,
    node: freezeNode(node),
    pathHash: pathFingerprint(path),
    statistics: EMPTY_STATISTICS,
  });
}

/** Assign IDs inside trusted code. The proposer never supplies executable code or IDs. */
export function instantiateProposal(proposal: NodeProposal, id: string): WorkflowNodeSpec {
  const node = freezeNode({ ...structuredClone(proposal), id } as WorkflowNodeSpec);
  validateNode(node);
  return node;
}

export function validateNodePath(nodes: readonly WorkflowNodeSpec[]): void {
  if (nodes.length < 1 || nodes.length > 24) throw new Error("A Node path requires 1..24 Nodes");
  if (nodes[0]?.type !== "CONTEXT.LOAD") throw new Error("The first search vertex must be CONTEXT.LOAD");
  const seen = new Map<string, WorkflowNodeSpec>();
  let latestGraphIndex = -1;
  let hasAnswerProducer = false;
  for (const node of nodes) {
    validateNode(node);
    if (node.type === "INFER.REASONING.REFLECT" && !hasAnswerProducer) {
      throw new Error("REFLECT requires an earlier answer-producing Infer Node in the path");
    }
    if (seen.has(node.id)) throw new Error(`Duplicate Node instance ID: ${node.id}`);
    const graphIndex = GRAPH_ORDER.indexOf(node.graphId);
    if (graphIndex < latestGraphIndex) throw new Error(`Graph stage ${node.graphId} cannot appear after a later stage`);
    latestGraphIndex = graphIndex;
    for (const dependency of node.dependencies) {
      const target = seen.get(dependency);
      if (!target) throw new Error(`Node ${node.id} has an unknown or forward dependency: ${dependency}`);
      if (target.graphId !== node.graphId) throw new Error(`Node ${node.id} has a cross-Graph dependency: ${dependency}`);
    }
    if (new Set(node.dependencies).size !== node.dependencies.length) throw new Error(`Node ${node.id} contains duplicate dependencies`);
    seen.set(node.id, node);
    if (node.type === "INFER.REASONING.TRAJECTORY" || node.type === "INFER.REASONING.SAMPLE" || node.type === "INFER.REASONING.DELIBERATE") {
      hasAnswerProducer = true;
    }
  }
  if (nodes.filter((node) => node.type === "CONTEXT.LOAD").length !== 1) {
    throw new Error("A path must contain exactly one CONTEXT.LOAD Node");
  }
  validateCheckerDependencies(nodes);
}

export function validateNode(node: WorkflowNodeSpec): void {
  if (!NODE_ID.test(node.id)) throw new Error(`Invalid Node instance ID: ${node.id}`);
  if (!GRAPH_ORDER.includes(node.graphId)) throw new Error(`Unsupported Graph stage: ${node.graphId}`);
  if (node.type === "CONTEXT.LOAD") {
    if (node.graphId !== "prepare" || node.dependencies.length !== 0) throw new Error("CONTEXT.LOAD must be dependency-free in prepare");
    return;
  }
  if('template' in node.config)throw Error('Tool/context-update nodes require an explicit Automation organization');
  if(!('generation' in node.config))throw Error('Inference generation is required');
  validateGeneration(node.config.generation);
  if (node.type === "INFER.REASONING.TRAJECTORY") {
    if (node.graphId !== "solve") throw new Error("TRAJECTORY belongs to solve");
    if (!node.config.instruction.trim() || node.config.instruction.length > 4_000) throw new Error("Invalid TRAJECTORY instruction");
    if (!STRATEGIES.includes(node.config.strategy)) throw new Error(`Unsupported trajectory strategy: ${node.config.strategy}`);
    validateStrategyOptions(node.config.strategy, node.config.options);
    integer(node.config.maxSteps, "maxSteps", 1, Number.MAX_SAFE_INTEGER);
    return;
  }
  if (node.type === "INFER.REASONING.SAMPLE") {
    if ((!isRawBaseline(node) && !node.config.instruction.trim()) || node.config.instruction.length > 4_000) throw new Error("Invalid SAMPLE instruction");
    return;
  }
  if (node.type === "INFER.REASONING.DELIBERATE") {
    if (node.graphId !== "solve" || !DELIBERATION_MODES.has(node.config.mode)) throw new Error("Invalid DELIBERATE configuration");
    if (node.dependencies.length < 2) throw new Error("DELIBERATE requires at least two local candidate dependencies");
    return;
  }
  if (node.type!== 'INFER.REASONING.REFLECT'||node.graphId !== "refine" || !REFLECTION_MODES.has(node.config.mode)) throw new Error("Invalid REFLECT configuration");
  if (node.config.criteria.length < 1 || node.config.criteria.length > 8 || node.config.criteria.some((item) => !item.trim())) {
    throw new Error("REFLECT requires 1..8 non-empty criteria");
  }
}

export function isRunnableNodePath(nodes: readonly WorkflowNodeSpec[]): boolean {
  try {
    validateNodePath(nodes);
  } catch {
    return false;
  }
  return nodes.some((node) => node.type.startsWith("INFER.")) && nodes.at(-1)?.type !== "CONTEXT.LOAD";
}

export function materializeAgentPlan(
  leafSearchNodeId: string,
  nodes: readonly WorkflowNodeSpec[],
  transitions?: Readonly<Record<string, GraphTransition>>,
): AgentPlanSpec {
  validateNodePath(nodes);
  if (!isRunnableNodePath(nodes)) throw new Error("The selected Node path is not executable yet");
  const activeGraphs = GRAPH_ORDER
    .map((id) => ({ id, nodeIds: nodes.filter((node) => node.graphId === id).map((node) => node.id) }))
    .filter((item) => item.nodeIds.length > 0);
  const defaultTransitions: Record<string, GraphTransition> = {};
  for (let index = 0; index < activeGraphs.length; index++) {
    const current = activeGraphs[index]!;
    const next = activeGraphs[index + 1];
    defaultTransitions[current.id] = next ? { kind: "next", graphId: next.id } : { kind: "end" };
  }
  const chosenTransitions = transitions ?? defaultTransitions;
  validateTransitions(activeGraphs.map((item) => item.id), chosenTransitions);
  const outputNode = [...nodes].reverse().find((node) => node.type !== "CONTEXT.LOAD");
  if (!outputNode) throw new Error("The plan does not have an output-capable Node");
  const fingerprint = pathFingerprint(nodes);
  return Object.freeze({
    id: `plan-${fingerprint.slice(0, 16)}`,
    leafSearchNodeId,
    nodes: Object.freeze(nodes.map(freezeNode)),
    graphs: Object.freeze(activeGraphs.map((item) => Object.freeze({ id: item.id, nodeIds: Object.freeze(item.nodeIds) }))),
    loop: Object.freeze({
      entryGraphId: activeGraphs[0]!.id,
      transitions: Object.freeze({ ...chosenTransitions }),
      maxGraphRuns: EXPERIMENT_EXECUTION.maxIterations,
    }),
    outputNodeId: outputNode.id,
  });
}

export function pathFingerprint(nodes: readonly WorkflowNodeSpec[]): string {
  return createHash("sha256").update(canonicalJson(nodes)).digest("hex");
}

export function nextNodeId(nodes: readonly WorkflowNodeSpec[], type: WorkflowNodeSpec["type"]): string {
  const stem = type.toLowerCase().replaceAll(".", "-");
  const ids = new Set(nodes.map((node) => node.id));
  for (let suffix = 1; suffix <= 999; suffix++) {
    const candidate = `${stem}-${suffix}`;
    if (!ids.has(candidate)) return candidate;
  }
  throw new Error(`No instance ID available for ${type}`);
}

export function defaultStrategyOptions(strategy: StrategyName): Readonly<Record<string, number>> {
  switch (strategy) {
    case "cot": return Object.freeze({ rounds: 1 });
    case "long-cot": return Object.freeze({ rounds: 3 });
    case "tot": return Object.freeze({ breadth: 2, depth: 2, beamWidth: 1 });
    case "got": return Object.freeze({ breadth: 2, depth: 2 });
    case "self-consistency": return Object.freeze({ candidates: 3 });
  }
}

function validateTransitions(graphIds: readonly string[], transitions: Readonly<Record<string, GraphTransition>>): void {
  const graphs = new Set(graphIds);
  for (const graphId of graphIds) {
    const transition = transitions[graphId];
    if (!transition) throw new Error(`Missing Loop transition for Graph: ${graphId}`);
    const targets = transition.kind === "next" ? [transition.graphId]
      : transition.kind === "repeat" ? [transition.graphId, transition.nextGraphId].filter(isString)
      : transition.kind === "switch" ? [...transition.cases.map((item) => item.graphId), transition.defaultGraphId].filter(isString)
      : [];
    for (const target of targets) if (!graphs.has(target)) throw new Error(`Loop transition references unknown Graph: ${target}`);
    if (transition.kind === "repeat") integer(transition.maxVisits, "maxVisits", 1, 16);
  }
  for (const source of Object.keys(transitions)) if (!graphs.has(source)) throw new Error(`Transition exists for unknown Graph: ${source}`);
}

function freezeNode<T extends WorkflowNodeSpec>(node: T): T {
  return Object.freeze({
    ...node,
    dependencies: Object.freeze([...node.dependencies]),
    config: Object.freeze(structuredClone(node.config)),
  }) as unknown as T;
}

function validateGeneration(value: { readonly temperature: number; readonly maxTokens: number }): void {
  finite(value.temperature, "temperature", 0, 2);
  integer(value.maxTokens, "maxTokens", 64, GENERATION.maxTokens);
}

function validateStrategyOptions(strategy: StrategyName, options: Readonly<Record<string, number>>): void {
  const allowed: Readonly<Record<StrategyName, Readonly<Record<string, readonly [number, number]>>>> = {
    cot: { rounds: [1, 8] },
    "long-cot": { rounds: [1, 8] },
    tot: { breadth: [1, 4], depth: [1, 4], beamWidth: [1, 4] },
    got: { breadth: [1, 4], depth: [1, 4] },
    "self-consistency": { candidates: [2, 7] },
  };
  for (const [key, value] of Object.entries(options)) {
    const range = allowed[strategy][key];
    if (!range) throw new Error(`Unsupported ${strategy} option: ${key}`);
    integer(value, `${strategy}.${key}`, range[0], range[1]);
  }
  for (const required of Object.keys(defaultStrategyOptions(strategy))) {
    if (!(required in options)) throw new Error(`Missing ${strategy} option: ${required}`);
  }
}

function finite(value: number, name: string, minimum: number, maximum: number): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${name} must be in [${minimum}, ${maximum}]`);
}

function integer(value: number, name: string, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer in [${minimum}, ${maximum}]`);
}

function isString(value: string | undefined): value is string {
  return typeof value === "string";
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
